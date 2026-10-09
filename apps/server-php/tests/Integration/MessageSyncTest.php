<?php

declare(strict_types=1);

namespace Fma\Tests\Integration;

use Fma\Config;
use Fma\Crypto\Envelope;
use Fma\Db\Database;
use Fma\Db\Uuid;
use Fma\Jobs\Deadline;
use Fma\Jobs\Job;
use Fma\Jobs\JobQueue;
use Fma\Jobs\MessageSyncJob;
use Fma\Log\Logger;
use Fma\Mail\FileStore;
use Fma\Mail\HostConfig;
use Fma\Mail\ImapClient;
use Fma\Mail\ImapMailbox;
use Fma\Mail\RawStorage;
use Fma\Mail\TransportPolicy;

/** message_sync against GreenMail (GREENMAIL_HOST, IMAP 3143, any login accepted). */
final class MessageSyncTest extends DatabaseTestCase
{
    private string $greenmail = '';
    private string $masterKey = '';
    private string $dataDir = '';
    private TransportPolicy $policy;
    /** @var resource */
    private $logStream;

    protected function setUp(): void
    {
        $host = getenv('GREENMAIL_HOST');
        if (!\is_string($host) || $host === '') {
            self::markTestSkipped('GREENMAIL_HOST not set');
        }
        $this->greenmail = $host;
        $this->masterKey = base64_encode(random_bytes(32));
        $this->policy = new TransportPolicy(allowPrivateHosts: true, insecureTransport: true);
        $this->dataDir = sys_get_temp_dir() . '/fma-msync-' . bin2hex(random_bytes(4));
        mkdir($this->dataDir);
        $stream = fopen('php://memory', 'w+b');
        self::assertIsResource($stream);
        $this->logStream = $stream;
    }

    protected function tearDown(): void
    {
        if ($this->dataDir !== '') {
            FileStore::removeTree($this->dataDir);
        }
    }

    /** @return array{account: string, folder: string, dek: string, user: string} */
    private function setUpAccount(): array
    {
        $user = 'ms-' . bin2hex(random_bytes(4)) . '@example.org';
        $pdo = self::$db->pdo();
        $userId = Uuid::v4();
        Database::run($pdo, 'INSERT INTO `user` (id, email, password_hash) VALUES (?, ?, ?)', [$userId, "{$user}.owner", 'x']);
        $id = Uuid::v4();
        $dek = Envelope::generateDataKey();
        Database::run(
            $pdo,
            'INSERT INTO mail_account (id, user_id, display_name, email_address, imap_host, imap_port, smtp_host, smtp_port, wrapped_dek, key_id, credential_enc)
             VALUES (?, ?, ?, ?, ?, 3143, ?, 3025, ?, ?, ?)',
            [$id, $userId, 'K', $user, $this->greenmail, $this->greenmail, Envelope::wrapDataKey(Envelope::loadMasterKey($this->masterKey), $dek, 'v1'), 'v1',
                Envelope::encryptField($dek, json_encode(['imapUser' => $user, 'imapPassword' => 'pw'], JSON_THROW_ON_ERROR), Envelope::credentialAad($id))],
        );
        $folder = Uuid::v4();
        Database::run($pdo, "INSERT INTO folder (id, account_id, path, special_use) VALUES (?, ?, 'INBOX', 'inbox')", [$folder, $id]);

        return ['account' => $id, 'folder' => $folder, 'dek' => $dek, 'user' => $user];
    }

    private function imap(string $user): ImapClient
    {
        return ImapClient::connect($this->policy, new HostConfig($this->greenmail, 3143, false, $user, 'pw'));
    }

    private function append(string $user, string $subject, string $messageId, string $flags = '', string $extraHeaders = '', string $body = "Hallo Welt\r\n", string $date = 'Mon, 5 Oct 2026 10:00:00 +0000', string $mailbox = 'INBOX'): void
    {
        $mail = "From: \"Alice Example\" <alice@example.org>\r\nTo: Bob <bob@example.org>\r\nSubject: {$subject}\r\nMessage-ID: {$messageId}\r\n"
            . "Date: {$date}\r\n{$extraHeaders}Content-Type: text/plain; charset=utf-8\r\n\r\n{$body}";
        $imap = $this->imap($user);
        $imap->command("APPEND {$mailbox} ({$flags}) {" . \strlen($mail) . "+}\r\n" . $mail);
        $imap->logout();
    }

    /**
     * @param array<string, mixed>  $payload
     * @param array<string, string> $env     extra configuration
     */
    private function sync(string $account, array $payload, float $seconds = 60, int $limit = MessageSyncJob::MESSAGE_SYNC_LIMIT, array $env = []): bool
    {
        $config = Config::fromArray(['MASTER_KEY' => $this->masterKey, 'MAIL_DATA_DIR' => $this->dataDir] + $env);
        $job = new MessageSyncJob(self::$db, $config, new JobQueue(self::$db), new FileStore($this->dataDir), new Logger('test', 'debug', $this->logStream), $this->policy, $limit);

        return $job->run(new Job('1', 'message_sync', $account, $payload, 1), new Deadline($seconds));
    }

    /** @return list<array{id: string, subject: string, thread_id: ?string, flags: list<string>, uid: int}> */
    private function messages(string $folder, string $dek): array
    {
        $rows = Database::run(
            self::$db->pdo(),
            'SELECT m.id, m.subject_enc, m.thread_id, ml.id AS location_id, ml.uid FROM message m JOIN message_location ml ON ml.message_id = m.id
             WHERE ml.folder_id = ? ORDER BY ml.uid',
            [$folder],
        )->fetchAll();
        $result = [];
        foreach ($rows as $row) {
            /** @var array{id: string, subject_enc: string, thread_id: ?string, location_id: string, uid: int|string} $row */
            $flags = Database::run(self::$db->pdo(), 'SELECT flag FROM message_flag WHERE location_id = ? ORDER BY flag', [$row['location_id']])->fetchAll(\PDO::FETCH_COLUMN);
            $result[] = [
                'id' => $row['id'],
                'subject' => Envelope::decryptField($dek, $row['subject_enc'], Envelope::messageFieldAad('subject', $row['id'])),
                'thread_id' => $row['thread_id'],
                'flags' => array_values(array_map('strval', $flags)),
                'uid' => (int) $row['uid'],
            ];
        }

        return $result;
    }

    private function unread(string $folder): int
    {
        return (int) Database::run(self::$db->pdo(), 'SELECT unread_count FROM folder WHERE id = ?', [$folder])->fetchColumn();
    }

    public function testFullSyncLifecycle(): void
    {
        $a = $this->setUpAccount();
        $secret = 'Geheimes Projekt Zebra';
        $this->append($a['user'], $secret, '<root-1@example.org>', '\\Seen');
        $this->append($a['user'], "Re: {$secret}", '<reply-1@example.org>', '', "In-Reply-To: <root-1@example.org>\r\nReferences: <root-1@example.org>\r\n");
        $this->append($a['user'], '=?UTF-8?B?w5xiZXIgZGllIEJyw7xja2U=?=', '<other-1@example.org>');

        // First sync: messages readable with the DEK, flags, threading.
        self::assertTrue($this->sync($a['account'], ['folderId' => $a['folder']]));
        $messages = $this->messages($a['folder'], $a['dek']);
        self::assertSame([$secret, "Re: {$secret}", 'Über die Brücke'], array_column($messages, 'subject'));
        self::assertContains('\\Seen', $messages[0]['flags']);
        self::assertNotContains('\\Seen', $messages[1]['flags']);
        self::assertNotNull($messages[0]['thread_id']);
        self::assertSame($messages[0]['thread_id'], $messages[1]['thread_id']);
        self::assertNotSame($messages[0]['thread_id'], $messages[2]['thread_id']);
        self::assertSame(2, $this->unread($a['folder']));

        $pdo = self::$db->pdo();
        // Every location carries the list sort key of its message.
        self::assertSame(0, (int) Database::run(
            $pdo,
            'SELECT COUNT(*) FROM message_location ml JOIN message m ON m.id = ml.message_id
             WHERE ml.folder_id = ? AND NOT (ml.sort_at <=> COALESCE(m.sent_at, m.received_at, m.created_at))',
            [$a['folder']],
        )->fetchColumn());
        /** @var array{from_enc: string, recipients_enc: string, snippet_enc: string, references: string, metadata_version: int|string} $row */
        $row = Database::run($pdo, 'SELECT from_enc, recipients_enc, snippet_enc, `references`, metadata_version FROM message WHERE id = ?', [$messages[1]['id']])->fetch();
        $id = $messages[1]['id'];
        self::assertSame('[{"name":"Alice Example","address":"alice@example.org"}]', Envelope::decryptField($a['dek'], $row['from_enc'], Envelope::messageFieldAad('from', $id)));
        self::assertSame(
            '{"to":[{"name":"Bob","address":"bob@example.org"}],"cc":[],"replyTo":[],"deliveredTo":[]}',
            Envelope::decryptField($a['dek'], $row['recipients_enc'], Envelope::messageFieldAad('recipients', $id)),
        );
        self::assertSame('Hallo Welt', Envelope::decryptField($a['dek'], $row['snippet_enc'], Envelope::messageFieldAad('snippet', $id)));
        self::assertSame(['<root-1@example.org>'], json_decode($row['references'], true));
        self::assertSame(3, (int) $row['metadata_version']);
        self::assertSame(1, (int) Database::run($pdo, 'SELECT COUNT(*) FROM message_reference WHERE message_id = ?', [$id])->fetchColumn());

        // Raw mail encrypted in the FileStore layout.
        $ref = (string) Database::run($pdo, 'SELECT storage_ref FROM message_body WHERE message_id = ?', [$id])->fetchColumn();
        self::assertSame(FileStore::storageRef($a['account'], $id), $ref);
        $rawFile = (string) file_get_contents("{$this->dataDir}/{$ref}");
        self::assertStringNotContainsString('Hallo Welt', $rawFile);
        $raw = (new RawStorage(Config::fromArray(['MAIL_DATA_DIR' => $this->dataDir]), new Logger('test', 'error', $this->logStream)))->read($a['dek'], $id, $ref);
        self::assertIsString($raw);
        self::assertStringContainsString('Hallo Welt', $raw);

        // Incremental: a new mail; flag change; deleted mail removed.
        $this->append($a['user'], 'Neue Nachricht', '<new-1@example.org>');
        $imap = $this->imap($a['user']);
        $imap->command('SELECT INBOX');
        $imap->command('UID STORE ' . $messages[1]['uid'] . ' +FLAGS (\\Seen \\Flagged)');
        $imap->command('UID STORE ' . $messages[2]['uid'] . ' +FLAGS (\\Deleted)');
        $imap->command('EXPUNGE');
        $imap->logout();
        self::assertTrue($this->sync($a['account'], ['folderId' => $a['folder']]));
        $after = $this->messages($a['folder'], $a['dek']);
        self::assertSame([$secret, "Re: {$secret}", 'Neue Nachricht'], array_column($after, 'subject'));
        self::assertContains('\\Flagged', $after[1]['flags']);
        self::assertContains('\\Seen', $after[1]['flags']);
        self::assertSame(0, (int) Database::run($pdo, 'SELECT COUNT(*) FROM message WHERE id = ?', [$messages[2]['id']])->fetchColumn());
        self::assertDirectoryDoesNotExist("{$this->dataDir}/{$a['account']}/{$messages[2]['id']}");
        self::assertSame(1, $this->unread($a['folder']));

        // UIDVALIDITY change: stale locations discarded, messages re-linked by Message-ID.
        Database::run($pdo, 'UPDATE folder SET uidvalidity = 1 WHERE id = ?', [$a['folder']]);
        Database::run($pdo, 'UPDATE message_location SET uidvalidity = 1 WHERE folder_id = ?', [$a['folder']]);
        self::assertTrue($this->sync($a['account'], ['folderId' => $a['folder']]));
        $relinked = $this->messages($a['folder'], $a['dek']);
        self::assertSame(array_column($after, 'id'), array_column($relinked, 'id'));
        self::assertNotSame(1, (int) Database::run($pdo, 'SELECT uidvalidity FROM folder WHERE id = ?', [$a['folder']])->fetchColumn());
        self::assertSame(0, (int) Database::run($pdo, 'SELECT COUNT(*) FROM message_location WHERE folder_id = ? AND uidvalidity = 1', [$a['folder']])->fetchColumn());

        // No plaintext subject in the database or the logs.
        $dump = '';
        foreach (['message', 'message_body', 'thread', 'folder', 'job'] as $table) {
            $dump .= json_encode(Database::run($pdo, "SELECT * FROM {$table}")->fetchAll(), JSON_INVALID_UTF8_SUBSTITUTE);
        }
        self::assertStringNotContainsString('Zebra', $dump);
        rewind($this->logStream);
        $logs = (string) stream_get_contents($this->logStream);
        self::assertStringNotContainsString('Zebra', $logs);
        self::assertStringNotContainsString('alice@example.org', $logs);
    }

    public function testInitialWindowAndDeadlineFollowUp(): void
    {
        $a = $this->setUpAccount();
        for ($i = 1; $i <= 4; ++$i) {
            $this->append($a['user'], "Nachricht {$i}", "<win-{$i}@example.org>");
        }
        // Expired budget: nothing fetched, folder state kept, follow-up enqueued.
        self::assertTrue($this->sync($a['account'], ['folderId' => $a['folder']], 0.0, 2));
        self::assertSame([], $this->messages($a['folder'], $a['dek']));
        self::assertNull(Database::run(self::$db->pdo(), 'SELECT uidvalidity FROM folder WHERE id = ?', [$a['folder']])->fetchColumn());
        self::assertSame(1, (int) Database::run(self::$db->pdo(), "SELECT COUNT(*) FROM job WHERE type = 'message_sync' AND account_id = ?", [$a['account']])->fetchColumn());

        // Window of 2: the newest two; load older brings the rest.
        self::assertTrue($this->sync($a['account'], ['folderId' => $a['folder']], 60, 2));
        self::assertSame(['Nachricht 3', 'Nachricht 4'], array_column($this->messages($a['folder'], $a['dek']), 'subject'));
        self::assertTrue($this->sync($a['account'], ['folderId' => $a['folder'], 'loadOlder' => true], 60, 2));
        self::assertSame(['Nachricht 1', 'Nachricht 2', 'Nachricht 3', 'Nachricht 4'], array_column($this->messages($a['folder'], $a['dek']), 'subject'));
    }

    public function testReferencesAndMetadataBackfill(): void
    {
        $a = $this->setUpAccount();
        $this->append($a['user'], 'Kette', '<chain-3@example.org>', '', "References: <chain-1@example.org>\r\n <chain-2@example.org>\r\nReply-To: list@example.org\r\nDelivered-To: me@example.org\r\n");
        self::assertTrue($this->sync($a['account'], ['folderId' => $a['folder']]));
        $pdo = self::$db->pdo();
        $id = $this->messages($a['folder'], $a['dek'])[0]['id'];
        $references = static fn(): mixed => json_decode((string) Database::run($pdo, 'SELECT `references` FROM message WHERE id = ?', [$id])->fetchColumn(), true);
        self::assertSame(['<chain-1@example.org>', '<chain-2@example.org>'], $references());
        $recipients = '{"to":[{"name":"Bob","address":"bob@example.org"}],"cc":[],"replyTo":[{"name":"","address":"list@example.org"}],"deliveredTo":["me@example.org"]}';
        $read = static fn(): string => Envelope::decryptField($a['dek'], (string) Database::run($pdo, 'SELECT recipients_enc FROM message WHERE id = ?', [$id])->fetchColumn(), Envelope::messageFieldAad('recipients', $id));
        self::assertSame($recipients, $read());

        // Outdated metadata (e.g. imported): re-derived from the stored raw mail.
        Database::run($pdo, "UPDATE message SET metadata_version = 1, `references` = '[]', recipients_enc = ? WHERE id = ?", [Envelope::encryptField($a['dek'], '{}', Envelope::messageFieldAad('recipients', $id)), $id]);
        Database::run($pdo, 'DELETE FROM message_reference WHERE message_id = ?', [$id]);
        self::assertTrue($this->sync($a['account'], ['folderId' => $a['folder']]));
        self::assertSame(['<chain-1@example.org>', '<chain-2@example.org>'], $references());
        self::assertSame($recipients, $read());
        self::assertSame(2, (int) Database::run($pdo, 'SELECT COUNT(*) FROM message_reference WHERE message_id = ?', [$id])->fetchColumn());

        // Without raw file: via IMAP.
        Database::run($pdo, "UPDATE message SET metadata_version = 1, `references` = '[]' WHERE id = ?", [$id]);
        FileStore::removeTree("{$this->dataDir}/{$a['account']}");
        self::assertTrue($this->sync($a['account'], ['folderId' => $a['folder']]));
        self::assertSame(['<chain-1@example.org>', '<chain-2@example.org>'], $references());
        self::assertSame(3, (int) Database::run($pdo, 'SELECT metadata_version FROM message WHERE id = ?', [$id])->fetchColumn());
    }

    /** @return array<string, ?string> Message-ID header -> thread id */
    private function threads(string $account): array
    {
        $rows = Database::run(self::$db->pdo(), 'SELECT message_id_header, thread_id FROM message WHERE account_id = ?', [$account])->fetchAll();

        return array_column($rows, 'thread_id', 'message_id_header');
    }

    public function testMergesThreadsWhenTheParentArrivesLaterInAnotherFolder(): void
    {
        $a = $this->setUpAccount();
        // The reply to <p@thread.test> arrives first; the parent only shows up later in Sent.
        $this->append($a['user'], 'Re: Re: Planung', '<c@thread.test>', '', "In-Reply-To: <p@thread.test>\r\nReferences: <p@thread.test>\r\n", "Kind\r\n", 'Thu, 3 Sep 2026 08:00:00 +0000');
        $this->append($a['user'], 'Planung', '<r@thread.test>', '', '', "Wurzel\r\n", 'Tue, 1 Sep 2026 08:00:00 +0000');
        // Same subject, no reply prefix, no references: unrelated.
        $this->append($a['user'], 'Planung', '<u@thread.test>', '', '', "Fremd\r\n", 'Wed, 2 Sep 2026 08:00:00 +0000');
        self::assertTrue($this->sync($a['account'], ['folderId' => $a['folder']]));
        $threads = $this->threads($a['account']);
        self::assertCount(3, array_filter($threads));
        self::assertNotSame($threads['<r@thread.test>'], $threads['<c@thread.test>']);
        self::assertNotSame($threads['<r@thread.test>'], $threads['<u@thread.test>']);

        $imap = $this->imap($a['user']);
        $imap->command('CREATE Sent');
        $imap->logout();
        $this->append($a['user'], 'Re: Planung', '<p@thread.test>', '\\Seen', "In-Reply-To: <r@thread.test>\r\nReferences: <r@thread.test>\r\n", "Elternteil\r\n", 'Wed, 2 Sep 2026 08:00:00 +0000', 'Sent');
        $sent = Uuid::v4();
        Database::run(self::$db->pdo(), "INSERT INTO folder (id, account_id, path, special_use) VALUES (?, ?, 'Sent', 'sent')", [$sent, $a['account']]);
        self::assertTrue($this->sync($a['account'], ['folderId' => $sent]));

        $threads = $this->threads($a['account']);
        $root = $threads['<r@thread.test>'];
        self::assertNotNull($root);
        self::assertSame($root, $threads['<p@thread.test>']);
        self::assertSame($root, $threads['<c@thread.test>']);
        self::assertNotSame($root, $threads['<u@thread.test>']);
        // The merged-away thread is gone; last_message_at follows the newest message.
        self::assertSame(2, (int) Database::run(self::$db->pdo(), 'SELECT COUNT(*) FROM thread WHERE account_id = ?', [$a['account']])->fetchColumn());
        self::assertSame('2026-09-03 08:00:00.000000', Database::run(self::$db->pdo(), 'SELECT last_message_at FROM thread WHERE id = ?', [$root])->fetchColumn());
    }

    public function testRemovesThreadsLeftWithoutMessages(): void
    {
        $a = $this->setUpAccount();
        $this->append($a['user'], 'Bleibt', '<keep@thread.test>');
        $this->append($a['user'], 'Verschwindet', '<gone@thread.test>');
        self::assertTrue($this->sync($a['account'], ['folderId' => $a['folder']]));
        $threads = $this->threads($a['account']);
        $gone = $threads['<gone@thread.test>'];
        self::assertNotNull($gone);
        self::assertNotSame($threads['<keep@thread.test>'], $gone);

        $imap = $this->imap($a['user']);
        $imap->command('SELECT INBOX');
        $imap->command('UID STORE ' . $this->messages($a['folder'], $a['dek'])[1]['uid'] . ' +FLAGS (\\Deleted)');
        $imap->command('EXPUNGE');
        $imap->logout();
        self::assertTrue($this->sync($a['account'], ['folderId' => $a['folder']]));

        self::assertSame(['<keep@thread.test>'], array_keys($this->threads($a['account'])));
        self::assertFalse(Database::run(self::$db->pdo(), 'SELECT 1 FROM thread WHERE id = ?', [$gone])->fetchColumn());
        self::assertSame(1, (int) Database::run(self::$db->pdo(), 'SELECT COUNT(*) FROM thread WHERE account_id = ?', [$a['account']])->fetchColumn());
    }

    public function testSkipsBodiesAboveMaxRawMessageBytes(): void
    {
        $a = $this->setUpAccount();
        $this->append($a['user'], 'Klein', '<small@example.org>');
        $this->append($a['user'], 'Riesig', '<large@example.org>', '', '', str_repeat("Zeile mit Inhalt\r\n", 200));
        $env = ['MAX_RAW_MESSAGE_BYTES' => '2000'];
        self::assertTrue($this->sync($a['account'], ['folderId' => $a['folder']], env: $env));

        // Both messages are listed with their metadata ...
        $messages = $this->messages($a['folder'], $a['dek']);
        self::assertSame(['Klein', 'Riesig'], array_column($messages, 'subject'));
        $pdo = self::$db->pdo();
        $body = static fn(string $id): mixed => Database::run($pdo, 'SELECT storage_ref, skip_reason FROM message_body WHERE message_id = ?', [$id])->fetch();
        self::assertSame(['storage_ref' => FileStore::storageRef($a['account'], $messages[0]['id']), 'skip_reason' => null], $body($messages[0]['id']));
        // ... but the oversized raw mail is neither downloaded nor stored: a skip marker instead.
        $large = $messages[1]['id'];
        self::assertSame(['storage_ref' => null, 'skip_reason' => 'too_large'], $body($large));
        self::assertDirectoryDoesNotExist("{$this->dataDir}/{$a['account']}/{$large}");
        self::assertSame('', Envelope::decryptField($a['dek'], (string) Database::run($pdo, 'SELECT snippet_enc FROM message WHERE id = ?', [$large])->fetchColumn(), Envelope::messageFieldAad('snippet', $large)));
        rewind($this->logStream);
        self::assertStringContainsString('too_large', (string) stream_get_contents($this->logStream));

        // The marker sticks: the next run does not try again (no duplicate rows, no file).
        self::assertTrue($this->sync($a['account'], ['folderId' => $a['folder']], env: $env));
        self::assertSame(1, (int) Database::run($pdo, 'SELECT COUNT(*) FROM message_body WHERE message_id = ?', [$large])->fetchColumn());
        self::assertDirectoryDoesNotExist("{$this->dataDir}/{$a['account']}/{$large}");

        // The pass for missing bodies (e.g. after a deadline; it runs when new
        // mail arrives) skips it by its stored size, too, instead of
        // downloading it first.
        Database::run($pdo, 'DELETE FROM message_body WHERE message_id = ?', [$large]);
        $this->append($a['user'], 'Neu', '<new@example.org>');
        self::assertGreaterThan(2000, (int) Database::run($pdo, 'SELECT size_bytes FROM message WHERE id = ?', [$large])->fetchColumn());
        self::assertTrue($this->sync($a['account'], ['folderId' => $a['folder']], env: $env));
        self::assertSame(['storage_ref' => null, 'skip_reason' => 'too_large'], $body($large));
        self::assertDirectoryDoesNotExist("{$this->dataDir}/{$a['account']}/{$large}");
    }

    public function testParsesFetchResponses(): void
    {
        $attrs = ImapMailbox::parseFetch("* 1 FETCH (FLAGS (\\Seen) UID 7 BODY[HEADER.FIELDS (REFERENCES)] {14}\r\nReferences: \r\n)\r\n");
        self::assertNotNull($attrs);
        self::assertSame('7', $attrs['UID']);
        self::assertSame(['\\Seen'], $attrs['FLAGS']);
        self::assertSame("References: \r\n", $attrs['BODY[HEADER]']);
        self::assertSame('1:3,7,9:10', ImapMailbox::uidSet([10, 1, 2, 3, 7, 9]));
        self::assertSame(['<a@b>', '<c@d>'], MessageSyncJob::referencesFromHeaderBlock("References: <a@b>\r\n <c@d>\r\n"));
        self::assertSame(['x@y.z'], MessageSyncJob::deliveredToFromHeaderBlock("Delivered-To: <X@y.z>\r\nX-Original-To: x@y.z\r\n"));
    }
}
