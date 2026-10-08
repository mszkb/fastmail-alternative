<?php

declare(strict_types=1);

namespace Fma\Jobs;

use Fma\Config;
use Fma\Db\Database;
use Fma\Log\Logger;
use Fma\Mail\AccountContext;
use Fma\Mail\ImapClient;
use Fma\Mail\ImapMailbox;
use Fma\Mail\MailException;
use Fma\Mail\TransportPolicy;

/**
 * IMAP IDLE for the INBOX in the long-running worker (ADR-0013). IDLE is a worker-managed connection, not a job:
 * one connection per active account with the INBOX open in IDLE; any change
 * the server reports (EXISTS, EXPUNGE, FETCH) only enqueues a message_sync
 * for that INBOX (deduplicated and debounced by enqueueMessageSync). The
 * periodic scheduler remains the fallback.
 *
 * PHP is single-threaded: poll() multiplexes all sockets with stream_select
 * and is called by bin/worker.php between short Runner::runOnce() passes.
 * Connecting (TLS, LOGIN, EXAMINE) blocks briefly; everything after that
 * (IDLE, DONE, re-IDLE) is driven by a small non-blocking state machine.
 *
 * - Accounts are reconciled periodically: new accounts get a connection,
 *   deleted/disabled accounts and accounts in auth_error or backoff
 *   (next_retry_at) are disconnected.
 * - Per-account isolation: every connection reconnects on its own with
 *   exponential backoff and jitter; an auth failure waits the maximum.
 * - Logs only contain account ids and error codes, never provider texts.
 */
final class IdleManager
{
    public const DEFAULT_MAX_CONNECTIONS = 50;
    public const DEFAULT_RECONCILE_SECONDS = 60;
    /** IDLE is restarted after this time (RFC 2177: servers may drop it after 30 min). */
    public const IDLE_RESTART_SECONDS = 25 * 60;
    /** A connection must stay up this long before its failure count is reset. */
    public const STABLE_SECONDS = 60;
    public const BACKOFF_BASE_SECONDS = 5;
    public const BACKOFF_MAX_SECONDS = 30 * 60;
    /** Waiting for '+' after IDLE or the tagged reply after DONE longer means a dead connection. */
    private const RESPONSE_TIMEOUT_SECONDS = 30;
    /** Blocking connects per poll() stop after this time; the rest follows next poll. */
    private const CONNECT_BUDGET_SECONDS = 5.0;
    private const CONNECT_TIMEOUT_SECONDS = 10.0;

    /** @var array<string, IdleConnection> by account id */
    private array $connections = [];
    private float $nextReconcile = 0.0;
    private bool $stopped = false;
    private readonly TransportPolicy $policy;
    private readonly int $maxConnections;
    private readonly int $syncMinIntervalSeconds;

    public function __construct(
        private readonly Database $db,
        private readonly JobQueue $queue,
        private readonly Config $config,
        private readonly Logger $logger,
        ?TransportPolicy $policy = null,
        ?int $maxConnections = null,
        private readonly int $reconcileSeconds = self::DEFAULT_RECONCILE_SECONDS,
        ?int $syncMinIntervalSeconds = null,
        private readonly int $idleRestartSeconds = self::IDLE_RESTART_SECONDS,
    ) {
        $this->policy = $policy ?? TransportPolicy::fromConfig($config);
        $this->maxConnections = $maxConnections ?? $config->int('IMAP_IDLE_MAX_CONNECTIONS', self::DEFAULT_MAX_CONNECTIONS);
        $this->syncMinIntervalSeconds = $syncMinIntervalSeconds ?? self::syncMinInterval($config);
    }

    /** IMAP_IDLE=0 (or false) disables IDLE (polling only). */
    public static function enabled(Config $config): bool
    {
        return !\in_array(strtolower($config->get('IMAP_IDLE')), ['0', 'false'], true);
    }

    /** SYNC_MIN_INTERVAL_SECONDS (default 10; 0 disables the debounce). */
    public static function syncMinInterval(Config $config): int
    {
        $value = $config->get('SYNC_MIN_INTERVAL_SECONDS');

        return preg_match('/^\d+$/', $value) === 1 ? (int) $value : 10;
    }

    /**
     * Backoff with full jitter in [delay/2, delay].
     *
     * @param (callable(): float)|null $random value in [0, 1]
     */
    public static function backoffSeconds(int $failures, ?callable $random = null): float
    {
        $delay = min(self::BACKOFF_MAX_SECONDS, self::BACKOFF_BASE_SECONDS * 2 ** min(20, max(0, $failures - 1)));
        $r = $random !== null ? $random() : mt_rand() / mt_getrandmax();

        return $delay / 2 + $r * $delay / 2;
    }

    /**
     * Failure count after a connection closed: only a connection that was
     * stable for STABLE_SECONDS starts over, so a server that accepts and
     * immediately drops connections still backs off exponentially.
     */
    public static function failuresAfterClose(int $failures, float $connectedForSeconds): int
    {
        return ($connectedForSeconds >= self::STABLE_SECONDS ? 0 : $failures) + 1;
    }

    /** @return list<string> account ids with an established IDLE connection */
    public function connectedAccountIds(): array
    {
        $ids = [];
        foreach ($this->connections as $connection) {
            if ($connection->connected()) {
                $ids[] = $connection->accountId;
            }
        }

        return $ids;
    }

    /** @return list<string> account ids the manager maintains (connected or reconnecting) */
    public function managedAccountIds(): array
    {
        return array_map('strval', array_keys($this->connections));
    }

    /**
     * One pass: reconcile when due, connect due connections, wait up to
     * `$timeoutSeconds` for server data and handle it, restart IDLE when due.
     */
    public function poll(float $timeoutSeconds): void
    {
        if ($this->stopped) {
            return;
        }
        if (microtime(true) >= $this->nextReconcile) {
            $this->reconcile();
        }
        $this->connectDue();

        $read = [];
        foreach ($this->connections as $connection) {
            if ($connection->client !== null) {
                $read[] = $connection->client->stream();
            }
        }
        if ($read === []) {
            if ($timeoutSeconds > 0) {
                usleep((int) ($timeoutSeconds * 1_000_000));
            }
        } else {
            $write = null;
            $except = null;
            $seconds = (int) floor($timeoutSeconds);
            // A signal (SIGTERM) interrupts select with a warning; the loop handles it.
            @stream_select($read, $write, $except, $seconds, (int) (($timeoutSeconds - $seconds) * 1_000_000));
        }
        // Read every connection, not only the ones select reported: PHP may
        // already hold decrypted TLS data in its buffer that select cannot see.
        $now = microtime(true);
        foreach ($this->connections as $connection) {
            if ($connection->client !== null) {
                $this->service($connection, $now);
            }
        }
    }

    /** Aligns the connections with the active accounts that have an INBOX. */
    public function reconcile(): void
    {
        if ($this->stopped) {
            return;
        }
        $this->nextReconcile = microtime(true) + $this->reconcileSeconds;
        try {
            // LIMIT as a literal int: native prepares do not accept a bound LIMIT everywhere.
            $rows = Database::run(
                $this->db->pdo(),
                "SELECT ma.id AS account_id, f.id AS folder_id
                 FROM mail_account ma
                 JOIN folder f ON f.account_id = ma.id AND UPPER(f.path) = 'INBOX'
                 WHERE ma.status NOT IN ('disabled', 'auth_error')
                   AND (ma.next_retry_at IS NULL OR ma.next_retry_at <= UTC_TIMESTAMP(6))
                   AND f.selectable
                 ORDER BY ma.created_at, ma.id
                 LIMIT " . max(1, $this->maxConnections),
            )->fetchAll();
        } catch (\Throwable $e) {
            $this->logger->error('idle reconcile failed', ['errName' => $e::class]);

            return;
        }
        $wanted = [];
        foreach ($rows as $row) {
            /** @var array{account_id: string, folder_id: string} $row */
            $wanted[(string) $row['account_id']] = (string) $row['folder_id'];
        }
        foreach ($this->connections as $accountId => $connection) {
            if (($wanted[(string) $accountId] ?? null) !== $connection->folderId) {
                unset($this->connections[$accountId]);
                $this->close($connection);
                $this->logger->info('idle stopped for account', ['accountId' => $connection->accountId]);
            }
        }
        foreach ($wanted as $accountId => $folderId) {
            $accountId = (string) $accountId;
            if (!isset($this->connections[$accountId])) {
                $this->connections[$accountId] = new IdleConnection($accountId, $folderId);
            }
        }
    }

    /** Closes all connections; poll() does nothing afterwards. */
    public function stop(): void
    {
        $this->stopped = true;
        foreach ($this->connections as $connection) {
            $this->close($connection);
        }
        $this->connections = [];
    }

    private function connectDue(): void
    {
        $start = microtime(true);
        foreach ($this->connections as $connection) {
            if ($connection->client !== null || $connection->retryAt > microtime(true)) {
                continue;
            }
            if (microtime(true) - $start >= self::CONNECT_BUDGET_SECONDS) {
                return;
            }
            $this->connect($connection);
        }
    }

    private function connect(IdleConnection $connection): void
    {
        $client = null;
        try {
            $account = AccountContext::load($this->db->pdo(), $connection->accountId, $this->config->get('MASTER_KEY'));
            // SSRF check and mandatory STARTTLS happen inside connect().
            $client = ImapClient::connect($this->policy, $account->imap, self::CONNECT_TIMEOUT_SECONDS);
            if (!\in_array('IDLE', $client->capabilities(), true)) {
                throw new MailException('IDLE_UNSUPPORTED', 'server has no IDLE');
            }
            (new ImapMailbox($client))->examine('INBOX');
            $connection->client = $client;
            $connection->buffer = '';
            $connection->connectedAt = microtime(true);
            $this->startIdle($connection, $connection->connectedAt);
            // After a reconnect, changes during the gap are picked up by a sync.
            if ($connection->failures > 0) {
                $this->enqueue($connection);
            }
            $this->logger->info('idle connected', ['accountId' => $connection->accountId]);
        } catch (\Throwable $e) {
            $client?->disconnect();
            $connection->client = null;
            $connection->state = IdleConnection::WAITING;
            ++$connection->failures;
            $code = self::errorCode($e);
            $delay = \in_array($code, ['AUTH_FAILED', 'CREDENTIALS_REQUIRED', 'IDLE_UNSUPPORTED'], true)
                ? (float) self::BACKOFF_MAX_SECONDS
                : self::backoffSeconds($connection->failures);
            $connection->retryAt = microtime(true) + $delay;
            $this->logger->warn('idle connect failed', ['accountId' => $connection->accountId, 'code' => $code, 'retryInMs' => (int) ($delay * 1000)]);
        }
    }

    private function startIdle(IdleConnection $connection, float $now): void
    {
        \assert($connection->client !== null);
        $connection->tag = $connection->client->sendIdle();
        $connection->state = IdleConnection::STARTING;
        $connection->stateSince = $now;
    }

    /** Reads pending data, handles complete lines and the IDLE timers. */
    private function service(IdleConnection $connection, float $now): void
    {
        $client = $connection->client;
        \assert($client !== null);
        try {
            $connection->buffer .= $client->readAvailable();
            while (($pos = strpos($connection->buffer, "\n")) !== false) {
                $line = rtrim(substr($connection->buffer, 0, $pos), "\r");
                $connection->buffer = substr($connection->buffer, $pos + 1);
                $this->handleLine($connection, $line, $now);
            }
            if (\strlen($connection->buffer) > 1_000_000) {
                throw new MailException('PROTOCOL', 'line too long');
            }
            if ($connection->state === IdleConnection::IDLING && $now - $connection->stateSince >= $this->idleRestartSeconds) {
                $client->sendDone();
                $connection->state = IdleConnection::ENDING;
                $connection->stateSince = $now;
            } elseif ($connection->state !== IdleConnection::IDLING && $now - $connection->stateSince >= self::RESPONSE_TIMEOUT_SECONDS) {
                throw new MailException('ETIMEDOUT', 'no response');
            }
        } catch (\Throwable $e) {
            $this->dropped($connection, self::errorCode($e), $now);
        }
    }

    private function handleLine(IdleConnection $connection, string $line, float $now): void
    {
        if (preg_match('/^\* \d+ (EXISTS|EXPUNGE|FETCH)\b/i', $line) === 1) {
            $this->enqueue($connection);
        } elseif ($connection->state === IdleConnection::STARTING && str_starts_with($line, '+')) {
            $connection->state = IdleConnection::IDLING;
            $connection->stateSince = $now;
        } elseif ($connection->tag !== '' && str_starts_with($line, $connection->tag . ' ')) {
            // Tagged completion of IDLE: after our DONE re-enter IDLE; otherwise the server ended it.
            if (strtoupper(substr($line, \strlen($connection->tag) + 1, 2)) !== 'OK' || $connection->state !== IdleConnection::ENDING) {
                throw new MailException('PROTOCOL', 'idle ended');
            }
            $this->startIdle($connection, $now);
        }
        // '* BYE' and anything else: ignored; a closing server shows up as EOF.
    }

    /** A connection was lost: reconnect with backoff. */
    private function dropped(IdleConnection $connection, string $code, float $now): void
    {
        $connection->client?->disconnect();
        $connection->client = null;
        $connection->state = IdleConnection::WAITING;
        $connection->failures = self::failuresAfterClose($connection->failures, $connection->connectedAt > 0 ? $now - $connection->connectedAt : 0.0);
        $connection->connectedAt = 0.0;
        $delay = self::backoffSeconds($connection->failures);
        $connection->retryAt = $now + $delay;
        $this->logger->info('idle connection closed, reconnecting', ['accountId' => $connection->accountId, 'code' => $code, 'retryInMs' => (int) ($delay * 1000)]);
    }

    private function close(IdleConnection $connection): void
    {
        $client = $connection->client;
        $connection->client = null;
        $connection->state = IdleConnection::WAITING;
        if ($client === null) {
            return;
        }
        try {
            // Best effort, without waiting for a reply (the server may be gone).
            $client->sendDone();
        } catch (\Throwable) {
            // closing anyway
        }
        $client->disconnect();
    }

    private function enqueue(IdleConnection $connection): void
    {
        try {
            $this->queue->enqueueMessageSync($connection->accountId, $connection->folderId, $this->syncMinIntervalSeconds);
        } catch (\Throwable $e) {
            $this->logger->error('idle enqueue failed', ['accountId' => $connection->accountId, 'errName' => $e::class]);
        }
    }

    private static function errorCode(\Throwable $e): string
    {
        return match (true) {
            $e instanceof AccountErrorException => $e->errorCode,
            $e instanceof MailException => $e->errorCode,
            default => (new \ReflectionClass($e))->getShortName(),
        };
    }
}
