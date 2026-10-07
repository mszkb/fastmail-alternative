<?php

declare(strict_types=1);

namespace Fma\Tests\Integration;

use Fma\App;
use Fma\Auth\Sessions;
use Fma\Config;
use Fma\Crypto\Envelope;
use Fma\Db\Database;
use Fma\Db\Uuid;
use Fma\Jobs\AccountErrorException;
use Fma\Jobs\Deadline;
use Fma\Jobs\Job;
use Fma\Jobs\JobQueue;
use Fma\Jobs\MessageActionJob;
use Fma\Log\Logger;
use Fma\Mail\FileStore;
use Fma\Mail\HostConfig;
use Fma\Mail\ImapClient;
use Fma\Mail\TransportPolicy;
use Fma\Tests\Support\FakeConnectionTester;
use Fma\Tests\Support\Http;

/**
 * message_action write-back against GreenMail (GREENMAIL_HOST, IMAP 3143),
 * port of apps/worker/test/message-action.test.ts. Actions go through
 * POST /api/messages/actions, the enqueued job is run directly.
 */
final class MessageActionJobTest extends DatabaseTestCase
{
    /** @var \Slim\App<\Psr\Container\ContainerInterface|null> */
    private \Slim\App $app;
    private string $greenmail = '';
    private string $masterKey;
    private string $token;
    private string $accountId;
    private string $dek;
    private string $imapUser;
    private string $dataDir;
    private TransportPolicy $policy;
    /** @var array<string, string> path => folder id */
    private array $folders = [];

    protected function setUp(): void
    {
        $host = getenv('GREENMAIL_HOST');
        if (!\is_string($host) || $host === '') {
            self::markTestSkipped('GREENMAIL_HOST not set');
        }
        $this->greenmail = $host;
        $this->policy = new TransportPolicy(allowPrivateHosts: true, insecureTransport: true);
        $pdo = self::$db->pdo();
        foreach (['job', 'mail_account', '`user`'] as $table) {
            $pdo->exec("DELETE FROM {$table}");
        }
        $this->masterKey = base64_encode(random_bytes(32));
        $this->dataDir = sys_get_temp_dir() . '/fma-action-' . bin2hex(random_bytes(4));
        mkdir($this->dataDir);
        $config = Config::fromArray(['DATABASE_URL' => self::$config->get('DATABASE_URL'), 'MASTER_KEY' => $this->masterKey, 'MAIL_DATA_DIR' => $this->dataDir]);
        $this->app = App::create($config, self::$db, new Logger('api', 'info', Http::memoryStream()), [], new FakeConnectionTester());
        $userId = Uuid::v4();
        Database::run($pdo, 'INSERT INTO `user` (id, email, password_hash) VALUES (?, ?, ?)', [$userId, 'me@example.org', 'unused']);
        $this->token = (new Sessions(self::$db))->createDeviceWithSession($userId, 'Test', 'desktop');

        $this->imapUser = 'action-' . bin2hex(random_bytes(4)) . '@example.org';
        $this->accountId = Uuid::v4();
        $this->dek = Envelope::generateDataKey();
        Database::run(
            $pdo,
            'INSERT INTO mail_account (id, user_id, display_name, email_address, imap_host, imap_port, smtp_host, smtp_port, wrapped_dek, key_id, credential_enc)
             VALUES (?, ?, ?, ?, ?, 3143, ?, 3025, ?, ?, ?)',
            [$this->accountId, $userId, 'K', $this->imapUser, $this->greenmail, $this->greenmail,
                Envelope::wrapDataKey(Envelope::loadMasterKey($this->masterKey), $this->dek, 'v1'), 'v1',
                Envelope::encryptField($this->dek, json_encode(['imapUser' => $this->imapUser, 'imapPassword' => 'pw'], JSON_THROW_ON_ERROR), Envelope::credentialAad($this->accountId))],
        );
        $imap = $this->imap();
        foreach (['Archiv', 'Trash'] as $path) {
            $imap->command('CREATE ' . ImapClient::quote($path));
        }
        $imap->logout();
        $this->folders = [
            'INBOX' => $this->folder('INBOX', 'inbox'),
            'Archiv' => $this->folder('Archiv', 'archive'),
            'Trash' => $this->folder('Trash', 'trash'),
        ];
    }

    protected function tearDown(): void
    {
        if (isset($this->dataDir) && is_dir($this->dataDir)) {
            FileStore::removeTree($this->dataDir);
        }
    }

    private function imap(): ImapClient
    {
        return ImapClient::connect($this->policy, new HostConfig($this->greenmail, 3143, false, $this->imapUser, 'pw'));
    }

    private function folder(string $path, ?string $specialUse): string
    {
        $id = Uuid::v4();
        Database::run(
            self::$db->pdo(),
            'INSERT INTO folder (id, account_id, path, delimiter, special_use, special_use_detected) VALUES (?, ?, ?, ?, ?, ?)',
            [$id, $this->accountId, $path, '/', $specialUse, $specialUse],
        );

        return $id;
    }

    /** Appends a mail at the provider and stores it locally (as a sync would); returns the message id. */
    private function mail(string $path, string $subject): string
    {
        $raw = "From: a@example.org\r\nTo: {$this->imapUser}\r\nSubject: {$subject}\r\nMessage-ID: <" . bin2hex(random_bytes(8)) . "@example.org>\r\n\r\nHallo\r\n";
        $imap = $this->imap();
        try {
            $result = $imap->execute(['APPEND ' . ImapClient::quote($path) . ' () ', $raw]);
        } finally {
            $imap->logout();
        }
        if (preg_match('/\[APPENDUID (\d+) (\d+)\]/', $result['tagged'], $m) !== 1) {
            self::fail('no APPENDUID');
        }
        $id = Uuid::v4();
        $pdo = self::$db->pdo();
        Database::run(
            $pdo,
            'INSERT INTO message (id, account_id, message_id_header, subject_enc, from_enc, recipients_enc, snippet_enc, sent_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))',
            [$id, $this->accountId, "<{$id}@example.org>", $this->enc($id, 'subject', $subject), $this->enc($id, 'from', '[]'), $this->enc($id, 'recipients', '{}'), $this->enc($id, 'snippet', '')],
        );
        Database::run($pdo, 'INSERT INTO message_location (id, message_id, folder_id, uidvalidity, uid) VALUES (?, ?, ?, ?, ?)', [Uuid::v4(), $id, $this->folders[$path], (int) $m[1], (int) $m[2]]);
        Database::run($pdo, 'UPDATE folder SET uidvalidity = ? WHERE id = ?', [(int) $m[1], $this->folders[$path]]);

        return $id;
    }

    /** @param list<string> $messageIds */
    private function act(string $path, string $action, array $messageIds, ?string $target = null): void
    {
        $body = ['folderId' => $this->folders[$path], 'action' => $action, 'messageIds' => $messageIds];
        if ($target !== null) {
            $body['targetFolderId'] = $this->folders[$target];
        }
        $request = Http::request('POST', '/api/messages/actions', ['Sec-Fetch-Site' => 'same-origin', 'Content-Type' => 'application/json'])
            ->withCookieParams(['fma_session' => $this->token]);
        $request->getBody()->write(json_encode($body, JSON_THROW_ON_ERROR));
        $response = $this->app->handle($request);
        self::assertSame(200, $response->getStatusCode(), (string) $response->getBody());
    }

    private function handler(): MessageActionJob
    {
        return new MessageActionJob(
            self::$db,
            Config::fromArray(['MASTER_KEY' => $this->masterKey]),
            new JobQueue(self::$db),
            new FileStore($this->dataDir),
            new Logger('worker', 'info', Http::memoryStream()),
            $this->policy,
        );
    }

    /** Runs all queued message_action jobs (oldest first); returns how many ran. */
    private function runJobs(): int
    {
        $pdo = self::$db->pdo();
        $rows = Database::run($pdo, "SELECT id, payload FROM job WHERE type = 'message_action' AND state = 'queued' ORDER BY id")->fetchAll();
        foreach ($rows as $row) {
            /** @var array{id: int|string, payload: string} $row */
            $payload = json_decode($row['payload'], true, flags: JSON_THROW_ON_ERROR);
            \assert(\is_array($payload));
            /** @var array<string, mixed> $payload */
            $this->handler()->run(new Job((string) $row['id'], 'message_action', $this->accountId, $payload, 1), new Deadline(30));
            Database::run($pdo, "UPDATE job SET state = 'done' WHERE id = ?", [$row['id']]);
        }

        return \count($rows);
    }

    /** @return array<int, list<string>> uid => flags at the provider */
    private function serverFlags(string $path): array
    {
        $imap = $this->imap();
        try {
            $imap->command('EXAMINE ' . ImapClient::quote($path));
            $lines = $imap->command('UID FETCH 1:* (FLAGS)');
        } catch (\Fma\Mail\MailException) {
            $lines = [];
        } finally {
            $imap->logout();
        }
        $result = [];
        foreach ($lines as $line) {
            if (preg_match('/UID (\d+)/', $line, $u) === 1 && preg_match('/FLAGS \(([^)]*)\)/', $line, $f) === 1) {
                $flags = array_values(array_filter(explode(' ', $f[1]), static fn(string $x): bool => $x !== '' && $x !== '\Recent'));
                sort($flags);
                $result[(int) $u[1]] = $flags;
            }
        }

        return $result;
    }

    /** @return list<array{folder_id: string, uidvalidity: int|string, uid: int|string}> */
    private function locations(string $messageId): array
    {
        /** @var list<array{folder_id: string, uidvalidity: int|string, uid: int|string}> */
        return Database::run(self::$db->pdo(), 'SELECT folder_id, uidvalidity, uid FROM message_location WHERE message_id = ?', [$messageId])->fetchAll();
    }

    private function syncJobs(): int
    {
        return (int) Database::run(self::$db->pdo(), "SELECT COUNT(*) FROM job WHERE type = 'message_sync' AND account_id = ?", [$this->accountId])->fetchColumn();
    }

    public function testWritesFlagChangesBack(): void
    {
        $a = $this->mail('INBOX', 'A');
        $b = $this->mail('INBOX', 'B');
        $this->act('INBOX', 'read', [$a, $b]);
        $this->act('INBOX', 'flag', [$a]);
        $this->act('INBOX', 'unread', [$b]);
        self::assertSame(3, $this->runJobs());

        self::assertSame([['\Flagged', '\Seen'], []], array_values($this->serverFlags('INBOX')));
        $flags = Database::run(self::$db->pdo(), 'SELECT CONVERT(mf.flag USING utf8mb4) FROM message_flag mf JOIN message_location ml ON ml.id = mf.location_id WHERE ml.message_id = ? ORDER BY 1', [$a])->fetchAll(\PDO::FETCH_COLUMN);
        self::assertSame(['\Flagged', '\Seen'], $flags);
        self::assertSame(0, $this->syncJobs());
    }

    public function testMovesAndLearnsTheNewUid(): void
    {
        $a = $this->mail('INBOX', 'A');
        $this->act('INBOX', 'archive', [$a]);
        $placeholder = $this->locations($a)[0];
        self::assertLessThan(0, (int) $placeholder['uid']);
        self::assertSame(1, $this->runJobs());

        self::assertSame([], $this->serverFlags('INBOX'));
        $archived = $this->serverFlags('Archiv');
        self::assertCount(1, $archived);
        $location = $this->locations($a);
        self::assertCount(1, $location);
        self::assertSame($this->folders['Archiv'], $location[0]['folder_id']);
        self::assertSame(array_key_first($archived), (int) $location[0]['uid']);
        self::assertGreaterThan(0, (int) $location[0]['uidvalidity']);
        // Both folders are resynced.
        self::assertSame(2, $this->syncJobs());
    }

    public function testDeletesToTrashThenPermanently(): void
    {
        $a = $this->mail('INBOX', 'A');
        $keep = $this->mail('INBOX', 'B');
        $this->act('INBOX', 'delete', [$a]);
        self::assertSame(1, $this->runJobs());
        self::assertCount(1, $this->serverFlags('INBOX'));
        self::assertCount(1, $this->serverFlags('Trash'));
        self::assertSame($this->folders['Trash'], $this->locations($a)[0]['folder_id']);

        $this->act('Trash', 'delete', [$a]);
        self::assertSame(1, $this->runJobs());
        self::assertSame([], $this->serverFlags('Trash'));
        self::assertFalse(Database::run(self::$db->pdo(), 'SELECT 1 FROM message WHERE id = ?', [$a])->fetchColumn());
        self::assertCount(1, $this->locations($keep));
    }

    public function testSkipsUidsGoneAtTheServer(): void
    {
        $a = $this->mail('INBOX', 'A');
        $this->act('INBOX', 'read', [$a]);
        // Another client expunges the message first.
        $imap = $this->imap();
        $imap->command('SELECT INBOX');
        $imap->command('UID STORE 1:* +FLAGS.SILENT (\Deleted)');
        $imap->command('EXPUNGE');
        $imap->logout();
        self::assertSame(1, $this->runJobs());
        self::assertSame([], $this->serverFlags('INBOX'));
    }

    public function testDropsTheActionOnUidvalidityMismatch(): void
    {
        $a = $this->mail('INBOX', 'A');
        $this->act('INBOX', 'read', [$a]);
        Database::run(self::$db->pdo(), "UPDATE job SET payload = JSON_SET(payload, '$.uidvalidity', '1') WHERE type = 'message_action'");
        self::assertSame(1, $this->runJobs());
        self::assertSame([[]], array_values($this->serverFlags('INBOX')));
        self::assertSame(1, $this->syncJobs());
    }

    public function testMissingFolderAndConnectionErrors(): void
    {
        $handler = $this->handler();
        $payload = ['operation' => 'read', 'folderId' => Uuid::v4(), 'uidvalidity' => '1', 'items' => [['uid' => 1, 'locationId' => Uuid::v4(), 'messageId' => Uuid::v4()]]];
        self::assertSame('folder_missing', $handler->runAction($this->accountId, $payload));
        self::assertFalse($handler->run(new Job('1', 'message_action', $this->accountId, $payload, 1), new Deadline(30)));

        try {
            $handler->runAction($this->accountId, ['operation' => 'bogus'] + $payload);
            self::fail('expected invalid payload');
        } catch (\RuntimeException $e) {
            self::assertSame('message_action job with invalid operation', $e->getMessage());
        }

        Database::run(self::$db->pdo(), 'UPDATE mail_account SET imap_port = 3999 WHERE id = ?', [$this->accountId]);
        try {
            $handler->runAction($this->accountId, ['folderId' => $this->folders['INBOX']] + $payload);
            self::fail('expected an account error');
        } catch (AccountErrorException $e) {
            self::assertSame('CONNECTION_REFUSED', $e->errorCode);
        }
    }

    /** @param 'subject'|'from'|'recipients'|'snippet' $field */
    private function enc(string $messageId, string $field, string $value): string
    {
        return Envelope::encryptField($this->dek, $value, Envelope::messageFieldAad($field, $messageId));
    }
}
