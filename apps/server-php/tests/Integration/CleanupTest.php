<?php

declare(strict_types=1);

namespace Fma\Tests\Integration;

use Fma\Config;
use Fma\Db\Database;
use Fma\Db\Uuid;
use Fma\Jobs\AccountCleanupJob;
use Fma\Jobs\CleanupJob;
use Fma\Jobs\JobQueue;
use Fma\Log\Logger;
use Fma\Mail\FileStore;
use Fma\Tests\Support\Http;

/**
 * cleanup and account_cleanup jobs, ported from
 * apps/worker/test/cleanup.test.ts and account-cleanup.test.ts (without
 * the provider part, which needs GreenMail and the sync jobs).
 */
final class CleanupTest extends DatabaseTestCase
{
    private const HOUR = 3600;
    private const DAY = 86400;
    private const SETTINGS = [
        'jobRetention' => 7 * self::DAY,
        'failedJobRetention' => 30 * self::DAY,
        'uploadRetention' => 24 * self::HOUR,
        'outboxRetention' => 30 * self::DAY,
        'orphanFileGrace' => 24 * self::HOUR,
    ];

    private string $dataDir;
    private string $userId;
    private string $accountId;
    private string $folderId;
    private CleanupJob $cleanup;
    private FileStore $files;

    protected function setUp(): void
    {
        $pdo = self::$db->pdo();
        foreach (['session', 'push_subscription', 'device', 'attachment_upload', 'outbox_message', 'draft', 'job', 'mail_account', '`user`'] as $table) {
            $pdo->exec("DELETE FROM {$table}");
        }
        $this->dataDir = sys_get_temp_dir() . '/fma-cleanup-' . bin2hex(random_bytes(6));
        mkdir($this->dataDir, 0o700, true);
        $this->files = new FileStore($this->dataDir);
        $this->cleanup = new CleanupJob(self::$db, $this->files, new Logger('worker', 'info', Http::memoryStream()), self::$config, self::SETTINGS);

        $this->userId = Uuid::v4();
        Database::run($pdo, 'INSERT INTO `user` (id, email, password_hash) VALUES (?, ?, ?)', [$this->userId, 'cleanup-' . bin2hex(random_bytes(4)) . '@example.com', 'x']);
        $this->accountId = $this->insertAccount();
        $this->folderId = Uuid::v4();
        Database::run($pdo, "INSERT INTO folder (id, account_id, path) VALUES (?, ?, 'INBOX')", [$this->folderId, $this->accountId]);
    }

    protected function tearDown(): void
    {
        FileStore::removeTree($this->dataDir);
    }

    private function insertAccount(): string
    {
        $id = Uuid::v4();
        Database::run(
            self::$db->pdo(),
            "INSERT INTO mail_account (id, user_id, display_name, email_address, imap_host, imap_port,
               smtp_host, smtp_port, wrapped_dek, key_id, credential_enc)
             VALUES (?, ?, 'Clean', 'clean@example.com', 'imap.test', 993, 'smtp.test', 465, 'x', 'v1', 'x')",
            [$id, $this->userId],
        );

        return $id;
    }

    /** Writes <dataDir>/<account>/<message>/raw.eml.enc, optionally backdated. */
    private function writeRaw(string $accountId, string $messageId, int $ageSeconds = 0): string
    {
        $dir = "{$this->dataDir}/{$accountId}/{$messageId}";
        if (!is_dir($dir)) {
            mkdir($dir, 0o700, true);
        }
        $file = "{$dir}/raw.eml.enc";
        file_put_contents($file, 'fma.b1.ciphertext');
        if ($ageSeconds > 0) {
            touch($file, time() - $ageSeconds);
            touch($dir, time() - $ageSeconds);
        }

        return $file;
    }

    /** @return array{id: string, file: ?string} */
    private function insertMessage(bool $location = true, bool $file = true): array
    {
        $pdo = self::$db->pdo();
        $id = Uuid::v4();
        Database::run(
            $pdo,
            "INSERT INTO message (id, account_id, message_id_header, subject_enc, from_enc, recipients_enc, snippet_enc)
             VALUES (?, ?, ?, 'x', 'x', 'x', 'x')",
            [$id, $this->accountId, "<{$id}@example.org>"],
        );
        if ($location) {
            Database::run(
                $pdo,
                'INSERT INTO message_location (id, message_id, folder_id, uidvalidity, uid) VALUES (?, ?, ?, 1, ?)',
                [Uuid::v4(), $id, $this->folderId, random_int(1, 2_000_000_000)],
            );
        }
        $path = null;
        if ($file) {
            $path = $this->writeRaw($this->accountId, $id);
            Database::run($pdo, 'INSERT INTO message_body (message_id, storage_ref) VALUES (?, ?)', [$id, FileStore::storageRef($this->accountId, $id)]);
        }

        return ['id' => $id, 'file' => $path];
    }

    private static function messageExists(string $id): bool
    {
        return Database::run(self::$db->pdo(), 'SELECT 1 FROM message WHERE id = ?', [$id])->fetchColumn() !== false;
    }

    /** @return list<string> */
    private static function ids(string $sql): array
    {
        $ids = array_map('strval', Database::run(self::$db->pdo(), $sql)->fetchAll(\PDO::FETCH_COLUMN));
        sort($ids);

        return $ids;
    }

    /** @return list<string> */
    private function listDir(string $dir): array
    {
        $entries = array_values(array_diff(scandir($dir) ?: [], ['.', '..']));
        sort($entries);

        return $entries;
    }

    public function testSettingsDefaultsAndEnvironment(): void
    {
        self::assertEquals(['uploadRetention' => 7 * 24 * self::HOUR] + self::SETTINGS, CleanupJob::settings(Config::fromArray([])));
        self::assertSame(
            ['jobRetention' => 7 * self::DAY, 'failedJobRetention' => 30 * self::DAY, 'uploadRetention' => 7 * 24 * self::HOUR, 'outboxRetention' => 30 * self::DAY, 'orphanFileGrace' => 24 * self::HOUR],
            CleanupJob::settings(Config::fromArray(['JOB_RETENTION_DAYS' => '0', 'FAILED_JOB_RETENTION_DAYS' => 'abc', 'OUTBOX_RETENTION_DAYS' => '-3'])),
        );
        $custom = CleanupJob::settings(Config::fromArray(['UPLOAD_RETENTION_HOURS' => '2', 'ORPHAN_FILE_GRACE_HOURS' => '0.5']));
        self::assertSame(2 * self::HOUR, $custom['uploadRetention']);
        self::assertSame(1800, $custom['orphanFileGrace']);
    }

    public function testRemovesMessagesWithoutLocationAndTheirFiles(): void
    {
        $kept = $this->insertMessage();
        $orphan = $this->insertMessage(location: false);
        $orphanNoBody = $this->insertMessage(location: false, file: false);
        // Its thread goes away with the last message.
        $threadId = Uuid::v4();
        Database::run(self::$db->pdo(), 'INSERT INTO thread (id, account_id) VALUES (?, ?)', [$threadId, $this->accountId]);
        Database::run(self::$db->pdo(), 'UPDATE message SET thread_id = ? WHERE id = ?', [$threadId, $orphan['id']]);

        $outcome = $this->cleanup->runCleanup();
        self::assertSame(2, $outcome['messages']);
        self::assertTrue(self::messageExists($kept['id']));
        self::assertFileExists((string) $kept['file']);
        self::assertFalse(self::messageExists($orphan['id']));
        self::assertFileDoesNotExist((string) $orphan['file']);
        self::assertDirectoryDoesNotExist(\dirname((string) $orphan['file']));
        self::assertFalse(self::messageExists($orphanNoBody['id']));
        self::assertFalse(Database::run(self::$db->pdo(), 'SELECT 1 FROM thread WHERE id = ?', [$threadId])->fetchColumn());
    }

    public function testLeavesMessagesWithoutLocationAloneWhileTheAccountIsBusy(): void
    {
        $pdo = self::$db->pdo();
        $orphan = $this->insertMessage(location: false);
        // A running sync may be relinking it (UIDVALIDITY change).
        Database::run($pdo, "INSERT INTO job (type, account_id, state, locked_at) VALUES ('message_sync', ?, 'running', UTC_TIMESTAMP(6))", [$this->accountId]);
        self::assertSame(0, $this->cleanup->purgeLocationlessMessages($this->accountId, true));
        self::assertTrue(self::messageExists($orphan['id']));

        // A pending expunge (message_action) owns it as well.
        $pdo->exec("UPDATE job SET state = 'done'");
        Database::run($pdo, "INSERT INTO job (type, account_id) VALUES ('message_action', ?)", [$this->accountId]);
        self::assertSame(0, $this->cleanup->purgeLocationlessMessages($this->accountId, true));

        $pdo->exec("UPDATE job SET state = 'done'");
        self::assertSame(1, $this->cleanup->purgeLocationlessMessages($this->accountId, true));
        self::assertFalse(self::messageExists($orphan['id']));
        self::assertFileDoesNotExist((string) $orphan['file']);
    }

    private function insertOutbox(string $status, ?string $content, int $ageDays = 0): string
    {
        $id = Uuid::v4();
        Database::run(
            self::$db->pdo(),
            'INSERT INTO outbox_message (id, account_id, status, content_enc, message_id_header, sent_copy, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6) - INTERVAL ? DAY)',
            [$id, $this->accountId, $status, $content, "<{$id}@example.org>", $status === 'sent' ? 'done' : null, $ageDays],
        );

        return $id;
    }

    private function insertUpload(?string $outboxId, int $ageHours, ?string $draftId = null): string
    {
        $id = Uuid::v4();
        Database::run(
            self::$db->pdo(),
            "INSERT INTO attachment_upload (id, account_id, outbox_id, draft_id, filename_enc, content_type, size_bytes, content_enc, created_at)
             VALUES (?, ?, ?, ?, 'x', 'text/plain', 1, 'x', UTC_TIMESTAMP(6) - INTERVAL ? HOUR)",
            [$id, $this->accountId, $outboxId, $draftId, $ageHours],
        );

        return $id;
    }

    public function testRemovesOldUnboundUploadsAndUploadsOfSettledMessages(): void
    {
        $queuedOutbox = $this->insertOutbox('queued', 'x');
        $failedRecent = $this->insertOutbox('failed', 'x', 2);
        $failedOld = $this->insertOutbox('failed', 'x', 31);
        $sentSettled = $this->insertOutbox('sent', null, 1);
        $sentOld = $this->insertOutbox('sent', null, 31);

        $this->insertUpload(null, 25);
        $unboundYoung = $this->insertUpload(null, 1);
        $boundQueued = $this->insertUpload($queuedOutbox, 48);
        $boundFailed = $this->insertUpload($failedRecent, 48);
        $this->insertUpload($sentSettled, 2);
        $this->insertUpload($failedOld, 48);

        $outcome = $this->cleanup->runCleanup();
        $expected = [$unboundYoung, $boundQueued, $boundFailed];
        sort($expected);
        self::assertSame($expected, self::ids('SELECT id FROM attachment_upload'));
        self::assertSame(2, $outcome['uploads']);

        $expectedOutbox = [$queuedOutbox, $failedRecent, $sentSettled];
        sort($expectedOutbox);
        $outbox = self::ids('SELECT id FROM outbox_message');
        self::assertSame($expectedOutbox, $outbox);
        self::assertNotContains($sentOld, $outbox);
        self::assertSame(2, $outcome['outbox']);
    }

    public function testKeepsUploadsOfAnExistingDraftAndRemovesThemWithTheDraft(): void
    {
        $draftId = Uuid::v4();
        Database::run(self::$db->pdo(), "INSERT INTO draft (id, account_id, content_enc) VALUES (?, ?, 'x')", [$draftId, $this->accountId]);
        $kept = $this->insertUpload(null, 30 * 24, $draftId);
        $this->cleanup->runCleanup();
        self::assertSame([$kept], self::ids('SELECT id FROM attachment_upload'));

        Database::run(self::$db->pdo(), 'DELETE FROM draft WHERE id = ?', [$draftId]);
        self::assertSame([], self::ids('SELECT id FROM attachment_upload'));
    }

    public function testKeepsRowsLockedByAConcurrentTransaction(): void
    {
        $outboxId = $this->insertOutbox('failed', 'x', 40);
        $uploadId = $this->insertUpload(null, 10 * 24);
        // Another connection binds the old upload (POST /api/outbox) and retries
        // the old failed message while the cleanup runs (not yet committed).
        $other = Database::connect(self::$config);
        $other->beginTransaction();
        Database::run($other, "UPDATE outbox_message SET status = 'queued', updated_at = UTC_TIMESTAMP(6) WHERE id = ?", [$outboxId]);
        Database::run($other, 'UPDATE attachment_upload SET outbox_id = ? WHERE id = ?', [$outboxId, $uploadId]);

        $outcome = $this->cleanup->runCleanup();
        $other->commit();

        self::assertSame(0, $outcome['uploads']);
        self::assertSame(0, $outcome['outbox']);
        self::assertSame([$uploadId], self::ids('SELECT id FROM attachment_upload'));
        self::assertSame('queued', Database::run(self::$db->pdo(), 'SELECT status FROM outbox_message WHERE id = ?', [$outboxId])->fetchColumn());
    }

    public function testRemovesOldFinishedAndFailedJobsNeverQueuedOrRunning(): void
    {
        $insert = function (string $state, int $ageDays): string {
            Database::run(
                self::$db->pdo(),
                "INSERT INTO job (type, state, run_at, created_at)
                 VALUES ('folder_sync', ?, UTC_TIMESTAMP(6) - INTERVAL ? DAY, UTC_TIMESTAMP(6) - INTERVAL ? DAY)",
                [$state, $ageDays, $ageDays],
            );

            return (string) self::$db->pdo()->lastInsertId();
        };
        $insert('done', 8);
        $doneNew = $insert('done', 1);
        $failedMid = $insert('failed', 8);
        $insert('failed', 31);
        $queuedOld = $insert('queued', 60);
        $runningOld = $insert('running', 60);

        $outcome = $this->cleanup->runCleanup();
        self::assertSame(2, $outcome['jobs']);
        $left = array_map('strval', Database::run(self::$db->pdo(), 'SELECT id FROM job ORDER BY id')->fetchAll(\PDO::FETCH_COLUMN));
        self::assertSame([$doneNew, $failedMid, $queuedOld, $runningOld], $left);
    }

    public function testRemovesExpiredSessionsDisabledPushSubscriptionsAndRuntimeState(): void
    {
        $pdo = self::$db->pdo();
        $deviceId = Uuid::v4();
        Database::run($pdo, "INSERT INTO device (id, user_id, name, platform, installation_id) VALUES (?, ?, 'Phone', 'ios_pwa', ?)", [$deviceId, $this->userId, Uuid::v4()]);
        Database::run(
            $pdo,
            'INSERT INTO session (id, device_id, token_hash, expires_at) VALUES
               (?, ?, ?, UTC_TIMESTAMP(6) - INTERVAL 1 MINUTE), (?, ?, ?, UTC_TIMESTAMP(6) + INTERVAL 1 DAY)',
            [Uuid::v4(), $deviceId, random_bytes(32), Uuid::v4(), $deviceId, random_bytes(32)],
        );
        Database::run(
            $pdo,
            "INSERT INTO push_subscription (id, device_id, transport, endpoint, keys_enc, disabled_at) VALUES
               (?, ?, 'webpush', 'https://push.example.net/a', 'x', NULL),
               (?, ?, 'webpush', 'https://push.example.net/b', 'x', UTC_TIMESTAMP(6) - INTERVAL 1 DAY),
               (?, ?, 'webpush', 'https://push.example.net/c', 'x', UTC_TIMESTAMP(6) - INTERVAL 31 DAY)",
            [Uuid::v4(), $deviceId, Uuid::v4(), $deviceId, Uuid::v4(), $deviceId],
        );
        $pdo->exec('DELETE FROM rate_limit');
        $pdo->exec('DELETE FROM login_lockout');
        Database::run($pdo, "INSERT INTO rate_limit (bucket, ip, window_start, hits) VALUES ('cleanup-test', '198.51.100.1', ?, 1)", [time() - 3600]);
        Database::run($pdo, "INSERT INTO login_lockout (ip, fails, window_start, locked_until) VALUES ('198.51.100.1', 3, ?, ?)", [time() - 86400, time() - 3600]);

        $outcome = $this->cleanup->runCleanup();
        self::assertSame(1, $outcome['sessions']);
        self::assertSame(1, $outcome['pushSubscriptions']);
        self::assertSame(1, (int) Database::run($pdo, 'SELECT COUNT(*) FROM session')->fetchColumn());
        self::assertSame(
            ['https://push.example.net/a', 'https://push.example.net/b'],
            Database::run($pdo, 'SELECT endpoint FROM push_subscription ORDER BY endpoint')->fetchAll(\PDO::FETCH_COLUMN),
        );
        self::assertFalse(Database::run($pdo, "SELECT 1 FROM rate_limit WHERE bucket = 'cleanup-test'")->fetchColumn());
        self::assertFalse(Database::run($pdo, "SELECT 1 FROM login_lockout WHERE ip = '198.51.100.1'")->fetchColumn());
    }

    public function testRemovesUnreferencedFilesOnlyAfterTheGracePeriod(): void
    {
        $old = 25 * self::HOUR;
        $referenced = $this->insertMessage();
        // Backdate the referenced file: age alone must never delete it.
        touch((string) $referenced['file'], time() - $old);
        touch(\dirname((string) $referenced['file']), time() - $old);

        $orphanOld = $this->writeRaw($this->accountId, Uuid::v4(), $old);
        $orphanNew = $this->writeRaw($this->accountId, Uuid::v4());
        // Body row without file reference (skip marker) does not protect a dir.
        $skipped = $this->insertMessage(file: false);
        Database::run(self::$db->pdo(), "INSERT INTO message_body (message_id, storage_ref, skip_reason) VALUES (?, NULL, 'too_large')", [$skipped['id']]);
        $skippedFile = $this->writeRaw($this->accountId, $skipped['id'], $old);
        // Directories of an account that no longer exists.
        $goneAccount = Uuid::v4();
        $goneOld = $this->writeRaw($goneAccount, Uuid::v4(), $old);
        touch("{$this->dataDir}/{$goneAccount}", time() - $old);
        $newAccount = Uuid::v4();
        $newAccountFile = $this->writeRaw($newAccount, Uuid::v4());
        // Anything outside our layout is left alone.
        file_put_contents("{$this->dataDir}/README", 'not ours');
        touch("{$this->dataDir}/README", time() - $old);

        self::assertSame(['messageDirs' => 2, 'accountDirs' => 1], $this->cleanup->removeOrphanFiles(self::SETTINGS['orphanFileGrace']));
        self::assertFileExists((string) $referenced['file']);
        self::assertFileDoesNotExist($orphanOld);
        self::assertDirectoryDoesNotExist(\dirname($orphanOld));
        self::assertFileExists($orphanNew);
        self::assertFileDoesNotExist($skippedFile);
        self::assertFileDoesNotExist($goneOld);
        self::assertDirectoryDoesNotExist("{$this->dataDir}/{$goneAccount}");
        self::assertFileExists($newAccountFile);
        $expected = [$this->accountId, $newAccount, 'README'];
        sort($expected);
        self::assertSame($expected, $this->listDir($this->dataDir));
    }

    public function testScansManyDirectoriesInBatches(): void
    {
        for ($i = 0; $i < 1203; ++$i) {
            $this->writeRaw($this->accountId, Uuid::v4(), 25 * self::HOUR);
        }
        $kept = $this->insertMessage();
        self::assertSame(1203, $this->cleanup->removeOrphanFiles(self::SETTINGS['orphanFileGrace'])['messageDirs']);
        self::assertSame([$kept['id']], $this->listDir("{$this->dataDir}/{$this->accountId}"));
    }

    public function testEnqueuesThePeriodicCleanupOncePerInterval(): void
    {
        $queue = new JobQueue(self::$db);
        self::assertTrue($queue->enqueueDueCleanup(3600));
        self::assertFalse($queue->enqueueDueCleanup(3600)); // queued
        self::$db->pdo()->exec("UPDATE job SET state = 'done' WHERE type = 'cleanup'");
        self::assertFalse($queue->enqueueDueCleanup(3600)); // too recent
        self::$db->pdo()->exec("UPDATE job SET created_at = UTC_TIMESTAMP(6) - INTERVAL 2 HOUR WHERE type = 'cleanup'");
        self::assertTrue($queue->enqueueDueCleanup(3600));
    }

    // ---- account_cleanup ----------------------------------------------------

    private function writeMessageFile(string $accountId): void
    {
        $this->writeRaw($accountId, Uuid::v4());
    }

    private function accountCleanup(): AccountCleanupJob
    {
        return new AccountCleanupJob(self::$db, new JobQueue(self::$db), $this->files);
    }

    public function testAccountCleanupRemovesTheFilesOfADeletedAccountAndSchedulesASecondPass(): void
    {
        FileStore::removeTree("{$this->dataDir}/{$this->accountId}");
        $deleted = Uuid::v4();
        $other = Uuid::v4();
        $this->writeMessageFile($deleted);
        $this->writeMessageFile($deleted);
        $this->writeMessageFile($other);

        self::assertSame('removed', $this->accountCleanup()->cleanup(['accountId' => $deleted]));
        self::assertSame([$other], $this->listDir($this->dataDir));

        $rows = Database::run(
            self::$db->pdo(),
            "SELECT payload, run_at > UTC_TIMESTAMP(6) + INTERVAL 1 HOUR AS is_delayed FROM job WHERE type = 'account_cleanup'",
        )->fetchAll();
        self::assertCount(1, $rows);
        // MySQL's JSON type does not keep the key order.
        self::assertEquals(['accountId' => $deleted, 'pass' => 2], json_decode((string) $rows[0]['payload'], true));
        self::assertSame(1, (int) $rows[0]['is_delayed']);

        // Second pass: late files are removed, no further pass.
        $this->writeMessageFile($deleted);
        self::assertSame('removed', $this->accountCleanup()->cleanup(['accountId' => $deleted, 'pass' => 2]));
        self::assertSame([$other], $this->listDir($this->dataDir));
        self::assertSame(1, (int) Database::run(self::$db->pdo(), "SELECT COUNT(*) FROM job WHERE type = 'account_cleanup'")->fetchColumn());
    }

    public function testAccountCleanupNeverTouchesTheFilesOfAnExistingAccount(): void
    {
        $this->writeMessageFile($this->accountId);
        self::assertSame('account_exists', $this->accountCleanup()->cleanup(['accountId' => $this->accountId]));
        self::assertContains($this->accountId, $this->listDir($this->dataDir));
    }

    public function testAccountCleanupRejectsIdsThatAreNotUuids(): void
    {
        $job = $this->accountCleanup();
        self::assertSame('invalid', $job->cleanup(['accountId' => '..']));
        self::assertSame('invalid', $job->cleanup(['accountId' => '../etc']));
        self::assertSame('invalid', $job->cleanup([]));
    }
}
