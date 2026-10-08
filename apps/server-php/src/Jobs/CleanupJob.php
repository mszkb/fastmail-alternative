<?php

declare(strict_types=1);

namespace Fma\Jobs;

use Fma\Config;
use Fma\Db\Database;
use Fma\Log\Logger;
use Fma\Mail\FileStore;
use Fma\Security\LoginLockout;
use Fma\Security\RateLimiter;

/**
 * `cleanup` job (roadmap 5.5),
 * enqueued by the runner every CLEANUP_INTERVAL_HOURS.
 *
 * Steps, each in batches of BATCH_SIZE in short transactions; between
 * batches the job stops when the Deadline has expired (the rest runs next
 * time):
 * 1. Messages without any location incl. their raw file, only for accounts
 *    without a running job and without a queued message_action.
 * 2. Uploads never bound to a message nor kept with a draft after
 *    UPLOAD_RETENTION_HOURS; uploads of settled (sent, content cleared) messages.
 * 3. Outbox entries sent and settled or failed, after OUTBOX_RETENTION_DAYS.
 * 4. Expired sessions; push subscriptions disabled for 30 days; the PHP
 *    runtime tables rate_limit and login_lockout.
 * 5. Finished (done/cancelled) jobs after JOB_RETENTION_DAYS, failed ones after
 *    FAILED_JOB_RETENTION_DAYS; queued and running jobs are never touched.
 * 6. Volume scan: message directories without a message_body row pointing
 *    at them and directories of accounts that no longer exist, only when
 *    older than ORPHAN_FILE_GRACE_HOURS.
 *
 * Rows first, files afterwards: a crash in between only leaves
 * unreferenced files (step 6), never rows without file. Every batch
 * selects with FOR UPDATE SKIP LOCKED and re-checks its conditions in the
 * DELETE, so rows changed concurrently (an upload just bound, a failed
 * message re-queued) are skipped or kept. Logs carry counters only.
 */
final class CleanupJob implements JobHandler
{
    public const BATCH_SIZE = 500;
    /** Disabled push subscriptions are kept this long (re-subscribe re-enables). */
    public const DISABLED_PUSH_RETENTION_SECONDS = 30 * 86400;

    /** @var array{jobRetention: int, failedJobRetention: int, uploadRetention: int, outboxRetention: int, orphanFileGrace: int} */
    public readonly array $settings;

    /** @param array{jobRetention: int, failedJobRetention: int, uploadRetention: int, outboxRetention: int, orphanFileGrace: int}|null $settings seconds */
    public function __construct(
        private readonly Database $db,
        private readonly FileStore $files,
        private readonly Logger $logger,
        Config $config,
        ?array $settings = null,
    ) {
        $this->settings = $settings ?? self::settings($config);
    }

    /**
     * Retention settings in seconds (defaults: 7 d, 30 d, 7 d, 30 d, 24 h);
     * missing, invalid or non-positive values fall back to the default.
     * Fractions are allowed (e.g. 0.5 hours).
     *
     * @return array{jobRetention: int, failedJobRetention: int, uploadRetention: int, outboxRetention: int, orphanFileGrace: int}
     */
    public static function settings(Config $config): array
    {
        $positive = static function (string $name, float $fallback) use ($config): float {
            $value = trim($config->get($name));
            $number = is_numeric($value) ? (float) $value : 0.0;

            return is_finite($number) && $number > 0 ? $number : $fallback;
        };

        return [
            'jobRetention' => (int) round($positive('JOB_RETENTION_DAYS', 7) * 86400),
            'failedJobRetention' => (int) round($positive('FAILED_JOB_RETENTION_DAYS', 30) * 86400),
            // 7 days: a message written offline with attachments can still be sent later.
            'uploadRetention' => (int) round($positive('UPLOAD_RETENTION_HOURS', 7 * 24) * 3600),
            'outboxRetention' => (int) round($positive('OUTBOX_RETENTION_DAYS', 30) * 86400),
            'orphanFileGrace' => (int) round($positive('ORPHAN_FILE_GRACE_HOURS', 24) * 3600),
        ];
    }

    public function run(Job $job, Deadline $deadline): bool
    {
        $outcome = $this->runCleanup($deadline);
        $this->logger->info('cleanup done', $outcome);

        return false;
    }

    /** @return array{messages: int, uploads: int, outbox: int, sessions: int, pushSubscriptions: int, jobs: int, orphanMessageDirs: int, orphanAccountDirs: int} */
    public function runCleanup(?Deadline $deadline = null): array
    {
        $deadline ??= new Deadline(3600);
        $pdo = $this->db->pdo();
        $s = $this->settings;

        // 1. Messages without location, per account (one failing account does not stop the others).
        $messages = 0;
        foreach (Database::run($pdo, 'SELECT id FROM mail_account ORDER BY id')->fetchAll(\PDO::FETCH_COLUMN) as $accountId) {
            if ($deadline->expired()) {
                break;
            }
            try {
                $messages += $this->purgeLocationlessMessages((string) $accountId, true, $deadline);
            } catch (\Throwable $e) {
                $this->logger->warn('cleanup of messages failed', ['accountId' => $accountId, 'error' => $e::class]);
            }
        }

        // 2. Uploads never bound nor kept with a draft (those go with the draft row) ...
        $unbound = 'outbox_id IS NULL AND draft_id IS NULL AND created_at < UTC_TIMESTAMP(6) - INTERVAL ? SECOND';
        $uploads = $this->deleteInBatches('attachment_upload', "SELECT id FROM attachment_upload WHERE {$unbound}", $unbound, [$s['uploadRetention']], $deadline);
        // ... and uploads of settled messages.
        $settled = "outbox_id IS NOT NULL AND EXISTS (SELECT 1 FROM outbox_message o
            WHERE o.id = attachment_upload.outbox_id AND o.status = 'sent' AND o.content_enc IS NULL)";
        $uploads += $this->deleteInBatches('attachment_upload', "SELECT id FROM attachment_upload WHERE {$settled}", $settled, [], $deadline);

        // 3. Settled or abandoned outbox entries (uploads cascade).
        $outboxCondition = "updated_at < UTC_TIMESTAMP(6) - INTERVAL ? SECOND
            AND ((status = 'sent' AND content_enc IS NULL) OR status = 'failed')";
        $outbox = $this->deleteInBatches('outbox_message', "SELECT id FROM outbox_message WHERE {$outboxCondition}", $outboxCondition, [$s['outboxRetention']], $deadline);

        // 4. Sessions past their absolute timeout; long-disabled push subscriptions; runtime tables.
        $sessions = $this->deleteInBatches('session', 'SELECT id FROM session WHERE expires_at < UTC_TIMESTAMP(6)', 'expires_at < UTC_TIMESTAMP(6)', [], $deadline);
        $pushCondition = 'disabled_at IS NOT NULL AND disabled_at < UTC_TIMESTAMP(6) - INTERVAL ? SECOND';
        $pushSubscriptions = $this->deleteInBatches('push_subscription', "SELECT id FROM push_subscription WHERE {$pushCondition}", $pushCondition, [self::DISABLED_PUSH_RETENTION_SECONDS], $deadline);
        (new RateLimiter($this->db, []))->prune();
        (new LoginLockout($this->db))->prune();

        // 5. Old jobs; queued/running stay.
        $jobCondition = "(state IN ('done', 'cancelled') AND run_at < UTC_TIMESTAMP(6) - INTERVAL ? SECOND)
            OR (state = 'failed' AND run_at < UTC_TIMESTAMP(6) - INTERVAL ? SECOND)";
        $jobParams = [$s['jobRetention'], $s['failedJobRetention']];
        $jobs = $this->deleteInBatches('job', "SELECT id FROM job WHERE {$jobCondition}", "({$jobCondition})", $jobParams, $deadline);

        // 6. Unreferenced files in the volume.
        $files = $deadline->expired() ? ['messageDirs' => 0, 'accountDirs' => 0] : $this->removeOrphanFiles($s['orphanFileGrace'], $deadline);

        return [
            'messages' => $messages,
            'uploads' => $uploads,
            'outbox' => $outbox,
            'sessions' => $sessions,
            'pushSubscriptions' => $pushSubscriptions,
            'jobs' => $jobs,
            'orphanMessageDirs' => $files['messageDirs'],
            'orphanAccountDirs' => $files['accountDirs'],
        ];
    }

    /**
     * Deletes messages of an account without any location, in batches, incl.
     * their raw files (rows first, then files). Returns the count.
     *
     * `onlyWhenIdle`: skip while the account has a running job or a queued
     * message_action (checked inside the DELETE) - for callers that are not
     * themselves the account's running job. folder_sync/message_sync pass false.
     */
    public function purgeLocationlessMessages(string $accountId, bool $onlyWhenIdle = false, ?Deadline $deadline = null): int
    {
        $pdo = $this->db->pdo();
        $idle = $onlyWhenIdle
            ? "AND NOT EXISTS (SELECT 1 FROM job j WHERE j.account_id = ? AND j.state = 'running')
               AND NOT EXISTS (SELECT 1 FROM job j WHERE j.account_id = ? AND j.type = 'message_action' AND j.state = 'queued')"
            : '';
        $idleParams = $onlyWhenIdle ? [$accountId, $accountId] : [];
        $total = 0;
        for (;;) {
            $refs = [];
            $pdo->beginTransaction();
            try {
                /** @var list<array{id: string, storage_ref: ?string}> $rows */
                $rows = Database::run(
                    $pdo,
                    'SELECT m.id, mb.storage_ref FROM message m
                     LEFT JOIN message_body mb ON mb.message_id = m.id
                     WHERE m.account_id = ?
                       AND NOT EXISTS (SELECT 1 FROM message_location ml WHERE ml.message_id = m.id)
                     LIMIT ' . self::BATCH_SIZE . '
                     FOR UPDATE SKIP LOCKED',
                    [$accountId],
                )->fetchAll();
                $deleted = [];
                if ($rows !== []) {
                    $ids = array_column($rows, 'id');
                    $in = implode(', ', array_fill(0, \count($ids), '?'));
                    // The DELETE re-checks: a location added meanwhile keeps the message.
                    Database::run(
                        $pdo,
                        "DELETE FROM message WHERE id IN ({$in}) AND account_id = ?
                           AND NOT EXISTS (SELECT 1 FROM message_location ml WHERE ml.message_id = message.id) {$idle}",
                        [...$ids, $accountId, ...$idleParams],
                    );
                    $left = array_flip(Database::run($pdo, "SELECT id FROM message WHERE id IN ({$in})", $ids)->fetchAll(\PDO::FETCH_COLUMN));
                    foreach ($rows as $row) {
                        if (!isset($left[$row['id']])) {
                            $deleted[] = $row['id'];
                            if ($row['storage_ref'] !== null) {
                                $refs[] = $row['storage_ref'];
                            }
                        }
                    }
                }
                $pdo->commit();
            } catch (\Throwable $e) {
                if ($pdo->inTransaction()) {
                    $pdo->rollBack();
                }
                throw $e;
            }
            foreach ($refs as $ref) {
                $this->files->removeMessageDir($ref);
            }
            $total += \count($deleted);
            // Fewer deleted than selected: the account is busy or rows changed; stop.
            if (\count($rows) < self::BATCH_SIZE || \count($deleted) < \count($rows) || ($deadline?->expired() ?? false)) {
                break;
            }
        }
        if ($total > 0) {
            Database::run(
                $pdo,
                'DELETE FROM thread WHERE account_id = ? AND NOT EXISTS (SELECT 1 FROM message m WHERE m.thread_id = thread.id)',
                [$accountId],
            );
        }

        return $total;
    }

    /**
     * Batched DELETE: select up to BATCH_SIZE ids with FOR UPDATE SKIP
     * LOCKED (rows locked right now are handled next run), delete them
     * re-checking the condition against the current row. `$select` and
     * `$condition` take the same `$params`.
     *
     * @param list<mixed> $params
     */
    private function deleteInBatches(string $table, string $select, string $condition, array $params, Deadline $deadline): int
    {
        $pdo = $this->db->pdo();
        $total = 0;
        for (;;) {
            $pdo->beginTransaction();
            try {
                $ids = array_values(Database::run($pdo, $select . ' LIMIT ' . self::BATCH_SIZE . ' FOR UPDATE SKIP LOCKED', $params)->fetchAll(\PDO::FETCH_COLUMN));
                $count = 0;
                if ($ids !== []) {
                    $in = implode(', ', array_fill(0, \count($ids), '?'));
                    $count = Database::run($pdo, "DELETE FROM {$table} WHERE id IN ({$in}) AND {$condition}", [...$ids, ...$params])->rowCount();
                }
                $pdo->commit();
            } catch (\Throwable $e) {
                if ($pdo->inTransaction()) {
                    $pdo->rollBack();
                }
                throw $e;
            }
            $total += $count;
            if (\count($ids) < self::BATCH_SIZE || $count === 0 || $deadline->expired()) {
                return $total;
            }
        }
    }

    /**
     * Scans mail-data for directories without a database reference. Memory
     * stays flat: directories are streamed and checked BATCH_SIZE at a time.
     *
     * @return array{messageDirs: int, accountDirs: int}
     */
    public function removeOrphanFiles(int $graceSeconds, ?Deadline $deadline = null): array
    {
        $pdo = $this->db->pdo();
        $cutoff = time() - $graceSeconds;
        $result = ['messageDirs' => 0, 'accountDirs' => 0];
        $accountIds = array_flip(array_map('strval', Database::run($pdo, 'SELECT id FROM mail_account')->fetchAll(\PDO::FETCH_COLUMN)));

        foreach ($this->files->scanIds() as $accountId) {
            if ($deadline !== null && $deadline->expired()) {
                break;
            }
            $accountDir = $this->files->root() . '/' . $accountId;
            if (!isset($accountIds[$accountId])) {
                // Deleted account (account_cleanup missed it) or one created after the
                // account list was read: the grace period tells them apart.
                $mtime = FileStore::newestMtime($accountDir);
                if ($mtime !== null && $mtime < $cutoff) {
                    FileStore::removeTree($accountDir);
                    ++$result['accountDirs'];
                }
                continue;
            }

            $batch = [];
            foreach ($this->files->scanIds($accountId) as $messageId) {
                $batch[] = $messageId;
                if (\count($batch) >= self::BATCH_SIZE) {
                    $result['messageDirs'] += $this->removeUnreferenced($accountId, $batch, $cutoff);
                    $batch = [];
                    if ($deadline !== null && $deadline->expired()) {
                        break;
                    }
                }
            }
            $result['messageDirs'] += $this->removeUnreferenced($accountId, $batch, $cutoff);
        }

        return $result;
    }

    /**
     * Removes the message directories of a batch that no message_body row
     * points at and that are older than the cutoff; returns how many.
     *
     * @param list<string> $messageIds
     */
    private function removeUnreferenced(string $accountId, array $messageIds, int $cutoff): int
    {
        if ($messageIds === []) {
            return 0;
        }
        $in = implode(', ', array_fill(0, \count($messageIds), '?'));
        $rows = Database::run(
            $this->db->pdo(),
            "SELECT message_id, storage_ref FROM message_body WHERE message_id IN ({$in}) AND storage_ref IS NOT NULL",
            $messageIds,
        )->fetchAll();
        $referenced = [];
        foreach ($rows as $row) {
            if (\is_array($row) && \is_string($row['storage_ref']) && \is_string($row['message_id'])
                && FileStore::refersTo($row['storage_ref'], $accountId, $row['message_id'])) {
                $referenced[$row['message_id']] = true;
            }
        }
        $removed = 0;
        foreach ($messageIds as $messageId) {
            if (isset($referenced[$messageId])) {
                continue;
            }
            $dir = $this->files->root() . "/{$accountId}/{$messageId}";
            $mtime = FileStore::newestMtime($dir);
            if ($mtime !== null && $mtime < $cutoff) {
                FileStore::removeTree($dir);
                ++$removed;
            }
        }

        return $removed;
    }
}
