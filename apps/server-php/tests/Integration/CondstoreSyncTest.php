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
use Fma\Mail\TransportPolicy;
use Fma\Tests\Support\Http;

/**
 * CONDSTORE (RFC 7162) in message_sync: incremental flag sync via
 * FETCH ... (CHANGEDSINCE n). GreenMail does not announce CONDSTORE (its runs
 * cover the full listing in MessageSyncTest), so this test talks to the
 * scripted server in tests/fixtures/fake-imap-server.php.
 */
final class CondstoreSyncTest extends DatabaseTestCase
{
    /** @var resource */
    private $process;
    private int $port = 0;
    private string $dir = '';
    private string $masterKey = '';
    private string $account = '';
    private string $folder = '';
    /** @var array{capabilities: string, highestModseq: ?int, uids: list<int>, flags: array<int, list<string>>, modseqs: array<int, int>} */
    private array $mailbox;

    protected function setUp(): void
    {
        $this->dir = sys_get_temp_dir() . '/fma-condstore-' . bin2hex(random_bytes(4));
        mkdir($this->dir);
        // Server: uid 1 got \Seen (modseq 12), uid 3 was expunged.
        $this->mailbox = [
            'capabilities' => 'IMAP4rev1 CONDSTORE',
            'highestModseq' => 12,
            'uids' => [1, 2],
            'flags' => [1 => ['\\Seen'], 2 => ['\\Flagged']],
            'modseqs' => [1 => 12, 2 => 5],
        ];
        $this->writeMailbox();
        touch("{$this->dir}/commands.log");
        $process = proc_open(
            [\PHP_BINARY, __DIR__ . '/../fixtures/fake-imap-server.php', "{$this->dir}/state.json", "{$this->dir}/commands.log"],
            [1 => ['pipe', 'w'], 2 => ['file', '/dev/null', 'w']],
            $pipes,
        );
        self::assertIsResource($process);
        $this->process = $process;
        stream_set_timeout($pipes[1], 5);
        self::assertSame(1, preg_match('/^PORT (\d+)$/', trim((string) fgets($pipes[1])), $m), 'fake IMAP server did not start');
        $this->port = (int) $m[1];

        $this->masterKey = base64_encode(random_bytes(32));
        $this->seedAccount();
    }

    protected function tearDown(): void
    {
        proc_terminate($this->process);
        proc_close($this->process);
        FileStore::removeTree($this->dir);
    }

    private function writeMailbox(): void
    {
        file_put_contents("{$this->dir}/state.json", json_encode($this->mailbox, JSON_THROW_ON_ERROR));
    }

    private function seedAccount(): void
    {
        $pdo = self::$db->pdo();
        $userId = Uuid::v4();
        Database::run($pdo, 'INSERT INTO `user` (id, email, password_hash) VALUES (?, ?, ?)', [$userId, "cs-{$userId}@example.org", 'x']);
        $this->account = Uuid::v4();
        $dek = Envelope::generateDataKey();
        Database::run(
            $pdo,
            "INSERT INTO mail_account (id, user_id, display_name, email_address, imap_host, imap_port, smtp_host, smtp_port, wrapped_dek, key_id, credential_enc)
             VALUES (?, ?, 'Condstore', 'user@condstore.test', '127.0.0.1', ?, '127.0.0.1', 3025, ?, 'v1', ?)",
            [$this->account, $userId, $this->port, Envelope::wrapDataKey(Envelope::loadMasterKey($this->masterKey), $dek, 'v1'),
                Envelope::encryptField($dek, json_encode(['imapUser' => 'user@condstore.test', 'imapPassword' => 'secret'], JSON_THROW_ON_ERROR), Envelope::credentialAad($this->account))],
        );
        $this->folder = Uuid::v4();
        Database::run($pdo, "INSERT INTO folder (id, account_id, path, special_use, uidvalidity, highestmodseq) VALUES (?, ?, 'INBOX', 'inbox', 7, 10)", [$this->folder, $this->account]);
        foreach ([1 => [], 2 => ['\\Flagged'], 3 => []] as $uid => $flags) {
            $id = Uuid::v4();
            Database::run(
                $pdo,
                'INSERT INTO message (id, account_id, message_id_header, subject_enc, from_enc, recipients_enc, snippet_enc, metadata_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                [$id, $this->account, "<{$id}@condstore.test>", Envelope::encryptField($dek, "Mail {$uid}", Envelope::messageFieldAad('subject', $id)), '', '', '', MessageSyncJob::MESSAGE_METADATA_VERSION],
            );
            // A body row: the sync must not try to download anything.
            Database::run($pdo, "INSERT INTO message_body (message_id, skip_reason) VALUES (?, 'test')", [$id]);
            $location = Uuid::v4();
            Database::run($pdo, 'INSERT INTO message_location (id, message_id, folder_id, uidvalidity, uid) VALUES (?, ?, ?, 7, ?)', [$location, $id, $this->folder, $uid]);
            foreach ($flags as $flag) {
                Database::run($pdo, 'INSERT INTO message_flag (location_id, flag) VALUES (?, ?)', [$location, $flag]);
            }
        }
    }

    private function sync(): void
    {
        file_put_contents("{$this->dir}/commands.log", '');
        $config = Config::fromArray(['MASTER_KEY' => $this->masterKey, 'MAIL_DATA_DIR' => $this->dir]);
        $policy = new TransportPolicy(allowPrivateHosts: true, insecureTransport: true);
        $job = new MessageSyncJob(self::$db, $config, new JobQueue(self::$db), new FileStore($this->dir), new Logger('test', 'error', Http::memoryStream()), $policy);
        self::assertTrue($job->run(new Job('1', 'message_sync', $this->account, ['folderId' => $this->folder], 1), new Deadline(10)));
    }

    /** @return list<string> */
    private function commands(string $pattern = '//'): array
    {
        $lines = file("{$this->dir}/commands.log", FILE_IGNORE_NEW_LINES) ?: [];

        return array_values(preg_grep($pattern, $lines) ?: []);
    }

    /** @return list<string> flag-related FETCH commands of the last sync */
    private function flagFetches(): array
    {
        return $this->commands('/ FETCH /i');
    }

    /** @return array<int, list<string>> uid -> flags */
    private function locations(): array
    {
        $result = [];
        $rows = Database::run(self::$db->pdo(), 'SELECT id, uid FROM message_location WHERE folder_id = ? ORDER BY uid', [$this->folder])->fetchAll();
        foreach ($rows as $row) {
            /** @var array{id: string, uid: int|string} $row */
            $flags = Database::run(self::$db->pdo(), 'SELECT flag FROM message_flag WHERE location_id = ? ORDER BY flag', [$row['id']])->fetchAll(\PDO::FETCH_COLUMN);
            $result[(int) $row['uid']] = array_values(array_map('strval', $flags));
        }

        return $result;
    }

    private function storedModseq(): ?string
    {
        $value = Database::run(self::$db->pdo(), 'SELECT highestmodseq FROM folder WHERE id = ?', [$this->folder])->fetchColumn();

        return $value === null ? null : (string) $value;
    }

    private function setStoredModseq(?string $modseq): void
    {
        Database::run(self::$db->pdo(), 'UPDATE folder SET highestmodseq = ? WHERE id = ?', [$modseq, $this->folder]);
    }

    public function testFetchesOnlyChangedFlagsAndDetectsExpunges(): void
    {
        $this->sync();
        self::assertCount(1, $this->commands('/EXAMINE "INBOX" \(CONDSTORE\)$/'));
        self::assertCount(1, $this->commands('/UID SEARCH ALL$/'));
        self::assertSame(['FETCH 1:* (UID FLAGS) (CHANGEDSINCE 10)'], self::withoutTags($this->flagFetches()));
        self::assertSame([1 => ['\\Seen'], 2 => ['\\Flagged']], $this->locations());
        self::assertSame('12', $this->storedModseq());

        // HIGHESTMODSEQ unchanged: no flag fetch at all; expunges are still found.
        $this->mailbox['uids'] = [2];
        $this->writeMailbox();
        $this->sync();
        self::assertSame([], $this->flagFetches());
        self::assertSame([2], array_keys($this->locations()));
        self::assertSame('12', $this->storedModseq());
    }

    public function testHandles63BitModseqValues(): void
    {
        $stored = 2 ** 62 + 1;
        $this->setStoredModseq((string) $stored);
        $this->mailbox['highestModseq'] = $stored + 4;
        $this->mailbox['modseqs'] = [1 => $stored + 4, 2 => $stored - 3];
        $this->writeMailbox();
        $this->sync();
        self::assertSame(["FETCH 1:* (UID FLAGS) (CHANGEDSINCE {$stored})"], self::withoutTags($this->flagFetches()));
        self::assertSame(['\\Seen'], $this->locations()[1]);
        self::assertSame((string) ($stored + 4), $this->storedModseq());
    }

    public function testFullListingWithoutStoredModseq(): void
    {
        $this->setStoredModseq(null);
        $this->sync();
        self::assertSame(['FETCH 1:* (UID FLAGS)'], self::withoutTags($this->flagFetches()));
        self::assertSame([], $this->commands('/SEARCH/'));
        self::assertSame([1 => ['\\Seen'], 2 => ['\\Flagged']], $this->locations());
        self::assertSame('12', $this->storedModseq());
    }

    public function testFullListingAfterFailedWriteBack(): void
    {
        Database::run(self::$db->pdo(), "INSERT INTO job (type, account_id, state, payload, run_at) VALUES ('message_action', ?, 'failed', '{}', UTC_TIMESTAMP(6))", [$this->account]);
        $this->sync();
        self::assertSame(['FETCH 1:* (UID FLAGS)'], self::withoutTags($this->flagFetches()));
        self::assertSame('12', $this->storedModseq());

        // After this sync the old failure no longer forces the full listing.
        $this->mailbox['highestModseq'] = 13;
        $this->mailbox['modseqs'][2] = 13;
        $this->mailbox['flags'][2] = [];
        $this->writeMailbox();
        $this->sync();
        self::assertSame(['FETCH 1:* (UID FLAGS) (CHANGEDSINCE 12)'], self::withoutTags($this->flagFetches()));
        self::assertSame([], $this->locations()[2]);
        self::assertSame('13', $this->storedModseq());
    }

    public function testFullListingWithoutCondstoreAndOnNomodseqMailbox(): void
    {
        $this->mailbox['capabilities'] = 'IMAP4rev1';
        $this->writeMailbox();
        $this->sync();
        self::assertCount(1, $this->commands('/EXAMINE "INBOX"$/'));
        self::assertSame(['FETCH 1:* (UID FLAGS)'], self::withoutTags($this->flagFetches()));
        self::assertSame(['\\Seen'], $this->locations()[1]);
        self::assertNull($this->storedModseq());

        $this->mailbox['capabilities'] = 'IMAP4rev1 CONDSTORE';
        $this->mailbox['highestModseq'] = null;
        $this->writeMailbox();
        $this->setStoredModseq('10');
        $this->sync();
        self::assertSame(['FETCH 1:* (UID FLAGS)'], self::withoutTags($this->flagFetches()));
        self::assertSame([1, 2], array_keys($this->locations()));
        self::assertNull($this->storedModseq());
    }

    /**
     * @param list<string> $lines
     *
     * @return list<string>
     */
    private static function withoutTags(array $lines): array
    {
        return array_map(static fn(string $line): string => (string) preg_replace('/^\S+ /', '', $line), $lines);
    }
}
