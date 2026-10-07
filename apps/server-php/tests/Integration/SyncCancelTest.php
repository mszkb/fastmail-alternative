<?php

declare(strict_types=1);

namespace Fma\Tests\Integration;

use Fma\App;
use Fma\Auth\Sessions;
use Fma\Config;
use Fma\Crypto\Envelope;
use Fma\Db\Database;
use Fma\Db\Uuid;
use Fma\Jobs\JobQueue;
use Fma\Log\Logger;
use Fma\Mail\FileStore;
use Fma\Mail\HostConfig;
use Fma\Mail\ImapClient;
use Fma\Mail\TransportPolicy;
use Fma\Tests\Support\FakeConnectionTester;
use Fma\Tests\Support\Http;
use PHPUnit\Framework\Attributes\DataProvider;
use Psr\Http\Message\ResponseInterface;

/**
 * Stopping a running sync (#119) end to end: two GreenMail accounts synced
 * by the real entry points (bin/cron.php, bin/worker.php with IMAP IDLE) in
 * a child process, one of them stopped through the API while its first
 * sync runs. Checks that the stop is quick and clean, the other account is
 * not affected, the next sync continues without duplicates, and that job
 * rows, the status API and the logs never contain names, subjects or
 * addresses (principles 5/6).
 */
final class SyncCancelTest extends DatabaseTestCase
{
    private const INBOX_MESSAGES = 150;
    private const FOLDER_MESSAGES = 5;
    private const FOLDER = 'Geheimprojekt Zebra';
    private const SUBJECT = 'Vertraulich Zebra';
    private const SENDER = 'alice.zebra@example.org';

    private string $greenmail = '';
    private string $masterKey = '';
    private string $dataDir = '';
    private string $token = '';
    /** @var \Slim\App<\Psr\Container\ContainerInterface|null> */
    private \Slim\App $app;
    private TransportPolicy $policy;

    protected function setUp(): void
    {
        $host = getenv('GREENMAIL_HOST');
        if (!\is_string($host) || $host === '') {
            self::markTestSkipped('GREENMAIL_HOST not set');
        }
        $this->greenmail = $host;
        $pdo = self::$db->pdo();
        foreach (['job', 'mail_account', '`user`'] as $table) {
            $pdo->exec("DELETE FROM {$table}");
        }
        $this->masterKey = base64_encode(random_bytes(32));
        $this->policy = new TransportPolicy(allowPrivateHosts: true, insecureTransport: true);
        $this->dataDir = sys_get_temp_dir() . '/fma-cancel-' . bin2hex(random_bytes(4));
        mkdir($this->dataDir);
        $config = Config::fromArray(['DATABASE_URL' => self::$config->get('DATABASE_URL'), 'DOMAIN' => 'mail.example.org', 'MASTER_KEY' => $this->masterKey]);
        $this->app = App::create($config, self::$db, new Logger('api', 'info', Http::memoryStream()), [], new FakeConnectionTester());
    }

    protected function tearDown(): void
    {
        if ($this->dataDir !== '') {
            FileStore::removeTree($this->dataDir);
        }
    }

    /** @return iterable<string, array{string}> */
    public static function entryPoints(): iterable
    {
        yield 'cron' => ['bin/cron.php'];
        yield 'worker with IDLE' => ['bin/worker.php'];
    }

    #[DataProvider('entryPoints')]
    public function testStopsOneAccountQuicklyAndContinuesWithoutDuplicates(string $entryPoint): void
    {
        $pdo = self::$db->pdo();
        $userId = Uuid::v4();
        Database::run($pdo, 'INSERT INTO `user` (id, email, password_hash) VALUES (?, ?, ?)', [$userId, 'owner@example.org', 'x']);
        $this->token = (new Sessions(self::$db))->createDeviceWithSession($userId, 'Test', 'desktop');
        $a = $this->account($userId, 'stop');
        $b = $this->account($userId, 'keep');
        $queue = new JobQueue(self::$db);
        $queue->enqueue('folder_sync', $a['id']);
        $queue->enqueue('folder_sync', $b['id']);

        // 1. Sync both; stop A once its INBOX sync has stored a first message.
        $process = $this->start($entryPoint, 'first');
        $statusWhileRunning = '';
        $cancelledAfter = null;
        $deadline = microtime(true) + 90;
        while (microtime(true) < $deadline) {
            if ($cancelledAfter === null && $this->locations($a['id'], 'INBOX') > 0) {
                $statusWhileRunning = (string) $this->call('GET', '/api/sync/status')->getBody();
                $requested = microtime(true);
                $response = $this->call('POST', "/api/accounts/{$a['id']}/sync/cancel");
                self::assertSame(200, $response->getStatusCode());
                self::assertTrue(Http::json($response)['cancelling']);
                while (microtime(true) - $requested < 10 && $this->activeSyncs($a['id']) > 0) {
                    usleep(20_000);
                }
                $cancelledAfter = microtime(true) - $requested;
            }
            if ($cancelledAfter !== null && $this->activeSyncs($a['id']) === 0 && $this->activeSyncs($b['id']) === 0) {
                break;
            }
            usleep(10_000);
        }
        $this->finish($process, $entryPoint);
        self::assertNotNull($cancelledAfter, 'A was never seen syncing');
        self::assertLessThan(5.0, $cancelledAfter, 'stopped within a few seconds');

        $status = json_decode($statusWhileRunning, true, flags: JSON_THROW_ON_ERROR);
        self::assertSame('running', $status['accounts'][0]['state']);
        self::assertSame('headers', $status['accounts'][0]['phase']);
        self::assertTrue(Uuid::isValid((string) $status['accounts'][0]['folderId']));

        // A: stopped mid-way, nothing half-stored, the folder state not advanced.
        $stored = $this->locations($a['id'], 'INBOX');
        self::assertGreaterThan(0, $stored);
        self::assertLessThan(self::INBOX_MESSAGES, $stored);
        self::assertNull($this->folder($a['id'], 'INBOX')['uidvalidity'], 'uidvalidity/highestmodseq are only committed by a complete run');
        self::assertSame(0, (int) Database::run($pdo, 'SELECT COUNT(*) FROM message m LEFT JOIN message_body b ON b.message_id = m.id WHERE m.account_id = ? AND b.message_id IS NULL', [$a['id']])->fetchColumn());
        self::assertGreaterThan(0, (int) Database::run($pdo, "SELECT COUNT(*) FROM job WHERE account_id = ? AND state = 'cancelled'", [$a['id']])->fetchColumn());
        self::assertSame(0, (int) Database::run($pdo, "SELECT COUNT(*) FROM job WHERE account_id = ? AND state IN ('queued', 'running', 'failed')", [$a['id']])->fetchColumn());
        self::assertSame('ok', Database::run($pdo, 'SELECT status FROM mail_account WHERE id = ?', [$a['id']])->fetchColumn());

        // B: not affected.
        self::assertSame(self::INBOX_MESSAGES, $this->locations($b['id'], 'INBOX'));
        self::assertSame(self::FOLDER_MESSAGES, $this->locations($b['id'], self::FOLDER));
        self::assertSame(0, (int) Database::run($pdo, "SELECT COUNT(*) FROM job WHERE account_id = ? AND state <> 'done'", [$b['id']])->fetchColumn());

        // 2. The next regular sync continues: everything once, no duplicates.
        $queue->enqueue('folder_sync', $a['id']);
        $process = $this->start($entryPoint, 'second');
        $deadline = microtime(true) + 90;
        while (microtime(true) < $deadline && ($this->activeSyncs($a['id']) > 0 || $this->locations($a['id'], 'INBOX') < self::INBOX_MESSAGES)) {
            usleep(50_000);
        }
        $logs = $this->finish($process, $entryPoint) . $this->logsOf('first');
        self::assertSame(self::INBOX_MESSAGES, $this->locations($a['id'], 'INBOX'));
        self::assertSame(self::FOLDER_MESSAGES, $this->locations($a['id'], self::FOLDER));
        $counts = Database::run($pdo, 'SELECT COUNT(*) AS n, COUNT(DISTINCT message_id_header) AS d FROM message WHERE account_id = ?', [$a['id']])->fetch();
        self::assertIsArray($counts);
        self::assertSame(self::INBOX_MESSAGES + self::FOLDER_MESSAGES, (int) $counts['n']);
        self::assertSame((int) $counts['n'], (int) $counts['d']);
        self::assertNotNull($this->folder($a['id'], 'INBOX')['uidvalidity']);

        // Principles 5/6: job rows, status API and logs carry ids, numbers and codes only.
        $jobs = json_encode(Database::run($pdo, 'SELECT * FROM job')->fetchAll(), JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE);
        $statusAfter = (string) $this->call('GET', '/api/sync/status')->getBody();
        foreach (['jobs' => $jobs, 'status while running' => $statusWhileRunning, 'status' => $statusAfter, 'logs' => $logs] as $what => $text) {
            foreach (['Zebra', 'Geheimprojekt', self::SENDER, $a['user'], $b['user'], 'INBOX'] as $plain) {
                self::assertStringNotContainsStringIgnoringCase($plain, $text, "{$what} must not contain '{$plain}'");
            }
        }
        self::assertStringContainsString('job cancelled', $logs);
    }

    /** @return array{id: string, user: string} */
    private function account(string $userId, string $prefix): array
    {
        $user = "{$prefix}-" . bin2hex(random_bytes(4)) . '@example.org';
        $id = Uuid::v4();
        $dek = Envelope::generateDataKey();
        Database::run(
            self::$db->pdo(),
            'INSERT INTO mail_account (id, user_id, display_name, email_address, imap_host, imap_port, smtp_host, smtp_port, wrapped_dek, key_id, credential_enc, sort_order)
             VALUES (?, ?, ?, ?, ?, 3143, ?, 3025, ?, ?, ?, ?)',
            [$id, $userId, $prefix, $user, $this->greenmail, $this->greenmail, Envelope::wrapDataKey(Envelope::loadMasterKey($this->masterKey), $dek, 'v1'), 'v1',
                Envelope::encryptField($dek, json_encode(['imapUser' => $user, 'imapPassword' => 'pw'], JSON_THROW_ON_ERROR), Envelope::credentialAad($id)),
                $prefix === 'stop' ? 0 : 1],
        );
        $imap = ImapClient::connect($this->policy, new HostConfig($this->greenmail, 3143, false, $user, 'pw'));
        $imap->command('CREATE "' . self::FOLDER . '"');
        for ($i = 1; $i <= self::INBOX_MESSAGES + self::FOLDER_MESSAGES; ++$i) {
            $mail = 'From: "Alice Zebra" <' . self::SENDER . ">\r\nTo: <{$user}>\r\nSubject: " . self::SUBJECT . " {$i}\r\n"
                . "Message-ID: <{$prefix}-{$i}@example.org>\r\nDate: Mon, 5 Oct 2026 10:00:00 +0000\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n"
                . str_repeat("Zebra-Inhalt {$i}\r\n", 20);
            $target = $i <= self::INBOX_MESSAGES ? 'INBOX' : '"' . self::FOLDER . '"';
            $imap->command("APPEND {$target} () {" . \strlen($mail) . "+}\r\n" . $mail);
        }
        $imap->logout();

        return ['id' => $id, 'user' => $user];
    }

    private function call(string $method, string $path): ResponseInterface
    {
        $request = Http::request($method, $path, ['Sec-Fetch-Site' => 'same-origin'])->withCookieParams(['fma_session' => $this->token]);

        return $this->app->handle($request);
    }

    private function locations(string $accountId, string $path): int
    {
        return (int) Database::run(
            self::$db->pdo(),
            'SELECT COUNT(*) FROM message_location ml JOIN folder f ON f.id = ml.folder_id WHERE f.account_id = ? AND f.path = ?',
            [$accountId, $path],
        )->fetchColumn();
    }

    /** @return array<string, mixed> */
    private function folder(string $accountId, string $path): array
    {
        $row = Database::run(self::$db->pdo(), 'SELECT uidvalidity, highestmodseq FROM folder WHERE account_id = ? AND path = ?', [$accountId, $path])->fetch();
        self::assertIsArray($row);

        return $row;
    }

    private function activeSyncs(string $accountId): int
    {
        return (int) Database::run(
            self::$db->pdo(),
            "SELECT COUNT(*) FROM job WHERE account_id = ? AND type IN ('folder_sync', 'message_sync') AND state IN ('queued', 'running')",
            [$accountId],
        )->fetchColumn();
    }

    /** @return resource */
    private function start(string $entryPoint, string $name)
    {
        $env = [
            'PATH' => (string) getenv('PATH'),
            'FMA_CONFIG' => $this->dataDir . '/no-config.php',
            'DATABASE_URL' => self::$config->get('DATABASE_URL'),
            'MASTER_KEY' => $this->masterKey,
            'MAIL_DATA_DIR' => $this->dataDir,
            'MAIL_ALLOW_PRIVATE_HOSTS' => '1',
            'MAIL_INSECURE_TRANSPORT' => '1',
            'LOG_LEVEL' => 'debug',
            'IMAP_IDLE' => '1',
            'WORKER_HEARTBEAT_FILE' => $this->dataDir . '/heartbeat',
            'CRON_TIME_BUDGET_SECONDS' => '80',
            // The test schedules the syncs itself.
            'SYNC_INTERVAL_SECONDS' => '3600',
        ];
        $log = "{$this->dataDir}/{$name}.log";
        $process = proc_open(
            [\PHP_BINARY, \dirname(__DIR__, 2) . '/' . $entryPoint],
            [0 => ['file', '/dev/null', 'r'], 1 => ['file', $log, 'a'], 2 => ['file', $log, 'a']],
            $pipes,
            \dirname(__DIR__, 2),
            $env,
        );
        self::assertIsResource($process);

        return $process;
    }

    /** @param resource $process */
    private function finish($process, string $entryPoint): string
    {
        if ($entryPoint === 'bin/worker.php') {
            // The worker stops after the running job on SIGTERM.
            proc_terminate($process, 15);
        }
        $deadline = microtime(true) + 30;
        while (proc_get_status($process)['running'] && microtime(true) < $deadline) {
            usleep(50_000);
        }
        if (proc_get_status($process)['running']) {
            proc_terminate($process, 9);
            self::fail("{$entryPoint} did not stop");
        }
        proc_close($process);

        return $this->logsOf('second');
    }

    private function logsOf(string $name): string
    {
        $file = "{$this->dataDir}/{$name}.log";

        return is_file($file) ? (string) file_get_contents($file) : '';
    }
}
