<?php

declare(strict_types=1);

namespace Fma\Tests\Integration;

use Fma\Config;
use Fma\Crypto\Envelope;
use Fma\Db\Database;
use Fma\Db\Uuid;
use Fma\Jobs\AccountHealth;
use Fma\Jobs\JobQueue;
use Fma\Jobs\Runner;
use Fma\Jobs\SendMessageJob;
use Fma\Log\Logger;
use Fma\Mail\TransportPolicy;
use Fma\Tests\Support\Http;

/** send_message against tests/fixtures/fake-smtp-server.php: AUTH_FAILED puts the account into auth_error (#176). */
final class SendAuthErrorTest extends DatabaseTestCase
{
    private string $masterKey;
    private JobQueue $queue;
    /** @var list<resource> */
    private array $servers = [];
    /** @var array<string, string> account id => data key */
    private array $deks = [];

    protected function setUp(): void
    {
        $this->masterKey = base64_encode(random_bytes(32));
        $this->queue = new JobQueue(self::$db);
        self::$db->pdo()->exec('DELETE FROM job');
    }

    protected function tearDown(): void
    {
        foreach ($this->servers as $process) {
            proc_terminate($process);
            proc_close($process);
        }
        $this->servers = [];
    }

    /** Starts the fake SMTP server in a mode and returns its port. */
    private function smtp(string $mode): int
    {
        $process = proc_open([\PHP_BINARY, __DIR__ . '/../fixtures/fake-smtp-server.php', $mode], [1 => ['pipe', 'w'], 2 => ['file', '/dev/null', 'w']], $pipes);
        self::assertIsResource($process);
        $this->servers[] = $process;
        stream_set_timeout($pipes[1], 5);
        if (preg_match('/^PORT (\d+)$/', trim((string) fgets($pipes[1])), $m) !== 1) {
            self::fail('fake SMTP server did not start');
        }

        return (int) $m[1];
    }

    private function account(int $smtpPort): string
    {
        $pdo = self::$db->pdo();
        $address = 'auth-' . bin2hex(random_bytes(4)) . '@example.org';
        $userId = Uuid::v4();
        Database::run($pdo, 'INSERT INTO `user` (id, email, password_hash) VALUES (?, ?, ?)', [$userId, "{$address}.owner", 'x']);
        $id = Uuid::v4();
        $dek = Envelope::generateDataKey();
        $this->deks[$id] = $dek;
        Database::run(
            $pdo,
            "INSERT INTO mail_account (id, user_id, display_name, email_address, imap_host, imap_port, smtp_host, smtp_port, wrapped_dek, key_id, credential_enc)
             VALUES (?, ?, 'Me', ?, '127.0.0.1', 1, '127.0.0.1', ?, ?, 'v1', ?)",
            [$id, $userId, $address, $smtpPort, Envelope::wrapDataKey(Envelope::loadMasterKey($this->masterKey), $dek, 'v1'),
                Envelope::encryptField($dek, json_encode(['imapUser' => $address, 'imapPassword' => 'pw'], JSON_THROW_ON_ERROR), Envelope::credentialAad($id))],
        );

        return $id;
    }

    /** Queues an outbox message with its send_message job. */
    private function outbox(string $accountId): string
    {
        $id = Uuid::v4();
        $content = ['from' => ['name' => '', 'address' => 'me@example.org'], 'to' => [['name' => '', 'address' => 'rcpt@example.org']], 'cc' => [], 'bcc' => [], 'subject' => 'Geheim', 'text' => 'Hallo'];
        Database::run(
            self::$db->pdo(),
            "INSERT INTO outbox_message (id, account_id, status, content_enc, message_id_header, `references`) VALUES (?, ?, 'queued', ?, ?, '[]')",
            [$id, $accountId, Envelope::encryptField($this->deks[$accountId], json_encode($content, JSON_THROW_ON_ERROR), Envelope::outboxContentAad($id)), "<{$id}@example.org>"],
        );
        $this->queue->enqueue('send_message', $accountId, ['outboxId' => $id]);

        return $id;
    }

    private function runner(): Runner
    {
        $config = Config::fromArray(['MASTER_KEY' => $this->masterKey]);
        $logger = new Logger('worker', 'error', Http::memoryStream());
        $policy = new TransportPolicy(allowPrivateHosts: true, insecureTransport: true);

        $runner = new Runner(self::$db, $this->queue, new AccountHealth(self::$db), $logger, $config);
        $runner->register('send_message', new SendMessageJob(self::$db, $config, $this->queue, $logger, $policy));

        return $runner;
    }

    /** @return array{0: string, 1: ?string} status and last_error_code */
    private function accountState(string $id): array
    {
        $row = Database::run(self::$db->pdo(), 'SELECT status, last_error_code FROM mail_account WHERE id = ?', [$id])->fetch(\PDO::FETCH_NUM);
        self::assertIsArray($row);

        return [(string) $row[0], $row[1] === null ? null : (string) $row[1]];
    }

    /** @return array{0: string, 1: ?string} status and last_error_code */
    private function outboxState(string $id): array
    {
        $row = Database::run(self::$db->pdo(), 'SELECT status, last_error_code FROM outbox_message WHERE id = ?', [$id])->fetch(\PDO::FETCH_NUM);
        self::assertIsArray($row);

        return [(string) $row[0], $row[1] === null ? null : (string) $row[1]];
    }

    private function jobState(string $outboxId): string
    {
        return (string) Database::run(self::$db->pdo(), "SELECT state FROM job WHERE type = 'send_message' AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.outboxId')) = ?", [$outboxId])->fetchColumn();
    }

    public function testRejectedLoginPutsOnlyThatAccountIntoAuthError(): void
    {
        $broken = $this->account($this->smtp('auth'));
        $healthy = $this->account($this->smtp('ok'));
        $first = $this->outbox($broken);
        $second = $this->outbox($broken);
        $other = $this->outbox($healthy);

        $this->runner()->runOnce(30);

        self::assertSame(['auth_error', 'AUTH_FAILED'], $this->accountState($broken));
        self::assertSame(['failed', 'AUTH_FAILED'], $this->outboxState($first));
        // No further send attempts for the account until the credentials change.
        self::assertSame(['queued', null], $this->outboxState($second));
        self::assertSame('queued', $this->jobState($second));
        self::assertNull($this->queue->claimNext(['send_message']));
        // Other accounts are untouched.
        self::assertSame(['ok', null], $this->accountState($healthy));
        self::assertSame('sent', $this->outboxState($other)[0]);

        // PATCH with working credentials resets the account (AccountRoutes, roadmap 3.4) ...
        Database::run(self::$db->pdo(), "UPDATE mail_account SET smtp_port = ?, status = 'ok', error_count = 0, next_retry_at = NULL, last_error_code = NULL WHERE id = ?", [$this->smtp('ok'), $broken]);
        // ... and POST /api/outbox/{id}/retry re-queues the failed message.
        Database::run(self::$db->pdo(), "UPDATE outbox_message SET status = 'queued', last_error_code = NULL WHERE id = ?", [$first]);
        $this->queue->enqueue('send_message', $broken, ['outboxId' => $first]);

        $this->runner()->runOnce(30);

        self::assertSame('ok', $this->accountState($broken)[0]);
        self::assertSame('sent', $this->outboxState($first)[0]);
        self::assertSame('sent', $this->outboxState($second)[0]);
    }

    public function testRejectedOrTemporaryRecipientKeepsTheAccountStatus(): void
    {
        $rejected = $this->account($this->smtp('rejected'));
        $temporary = $this->account($this->smtp('temporary'));
        $a = $this->outbox($rejected);
        $b = $this->outbox($temporary);

        $this->runner()->runOnce(30);

        self::assertSame(['failed', 'SMTP_REJECTED'], $this->outboxState($a));
        self::assertSame(['queued', 'SMTP_TEMPORARY'], $this->outboxState($b));
        self::assertSame(['ok', null], $this->accountState($rejected));
        self::assertSame(['ok', null], $this->accountState($temporary));
    }
}
