<?php

declare(strict_types=1);

namespace Fma\Jobs;

use Fma\Db\Database;

/**
 * Job queue on the `job` table (ADR-0003), including the scheduler queries:
 * - claims with SELECT ... FOR UPDATE SKIP LOCKED, so parallel runners never
 *   take the same job;
 * - per-account isolation: one running job per account, no jobs of an
 *   account in auth_error/disabled or in backoff (next_retry_at);
 * - at most IMAP_MAX_CONNECTIONS_PER_HOST running jobs per IMAP host,
 *   counted in the database (no shared memory between PHP processes);
 * - retries with backoff 30 s * 2^(n-1), at most 1 h; 'failed' after 5;
 * - cooperative cancellation of syncs (#119): queued sync jobs of an
 *   account end as 'cancelled' at once, running ones get
 *   cancel_requested_at and stop between batches (SyncProgress); a job
 *   asked to cancel is never retried or re-queued.
 * Payloads hold ids only; last_error holds codes only.
 */
final class JobQueue
{
    public const MAX_ATTEMPTS = 5;
    /** Job types that make up a sync (#119: progress, cancel, status). */
    public const SYNC_TYPES = ['folder_sync', 'message_sync'];
    private const BACKOFF_BASE_SECONDS = 30;
    private const BACKOFF_MAX_SECONDS = 3600;
    /** Retry interval after a folder_sync ran out of attempts. */
    private const FAILED_RETRY_INTERVAL_SECONDS = 3600;

    public function __construct(private readonly Database $db, private readonly int $maxConnectionsPerHost = 4) {}

    /** @param list<mixed> $params */
    private function run(string $sql, array $params = []): \PDOStatement
    {
        return Database::run($this->db->pdo(), $sql, $params);
    }

    /** @param array<string, mixed> $payload */
    public function enqueue(string $type, ?string $accountId = null, array $payload = [], int $delaySeconds = 0): string
    {
        $this->run(
            'INSERT INTO job (type, account_id, payload, run_at) VALUES (?, ?, ?, UTC_TIMESTAMP(6) + INTERVAL ? SECOND)',
            [$type, $accountId, json_encode((object) $payload, JSON_THROW_ON_ERROR), max(0, $delaySeconds)],
        );

        return (string) $this->db->pdo()->lastInsertId();
    }

    /**
     * Atomically claims the oldest eligible queued job of the given types,
     * marks it running and counts the attempt.
     *
     * @param list<string> $types
     */
    public function claimNext(array $types): ?Job
    {
        if ($types === []) {
            return null;
        }
        $pdo = $this->db->pdo();
        $in = implode(', ', array_fill(0, \count($types), '?'));
        $pdo->beginTransaction();
        try {
            /** @var array{id: int|string, type: string, account_id: ?string, payload: string, attempts: int|string}|false $row */
            $row = Database::run(
                $pdo,
                "SELECT j.id, j.type, j.account_id, j.payload, j.attempts FROM job j
                 LEFT JOIN mail_account a ON a.id = j.account_id
                 WHERE j.state = 'queued' AND j.run_at <= UTC_TIMESTAMP(6) AND j.type IN ({$in})
                   AND (j.account_id IS NULL OR (
                     -- Circuit breaker: skip accounts in backoff or with an auth error.
                     a.status NOT IN ('auth_error', 'disabled')
                     AND (a.next_retry_at IS NULL OR a.next_retry_at <= UTC_TIMESTAMP(6))
                     -- One running job per account.
                     AND NOT EXISTS (SELECT 1 FROM job r WHERE r.account_id = j.account_id AND r.state = 'running')
                     -- Connection limit per IMAP host across all accounts.
                     AND (SELECT COUNT(*) FROM job r JOIN mail_account ra ON ra.id = r.account_id
                          WHERE r.state = 'running' AND LOWER(ra.imap_host) = LOWER(a.imap_host)) < ?
                   ))
                 ORDER BY j.run_at, j.id
                 LIMIT 1
                 FOR UPDATE SKIP LOCKED",
                [...$types, $this->maxConnectionsPerHost],
            )->fetch();
            if ($row === false) {
                $pdo->rollBack();

                return null;
            }
            Database::run($pdo, "UPDATE job SET state = 'running', locked_at = UTC_TIMESTAMP(6), attempts = attempts + 1 WHERE id = ?", [$row['id']]);
            $pdo->commit();
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
        $payload = json_decode($row['payload'], true);

        return new Job((string) $row['id'], $row['type'], $row['account_id'], \is_array($payload) ? $payload : [], (int) $row['attempts'] + 1);
    }

    public function complete(string $jobId): void
    {
        $this->run("UPDATE job SET state = 'done', last_error = NULL WHERE id = ?", [$jobId]);
    }

    /** A job that stopped on a cancel request (#119); run_at records when. */
    public function markCancelled(string $jobId): void
    {
        $this->run("UPDATE job SET state = 'cancelled', run_at = UTC_TIMESTAMP(6) WHERE id = ?", [$jobId]);
    }

    /** Progress reporter and cancel check of a running sync job. */
    public function progress(string $jobId): SyncProgress
    {
        return new SyncProgress($this->db, $jobId);
    }

    /** Retry with backoff while attempts remain, else terminal 'failed'; a job asked to cancel ends 'cancelled'. */
    public function fail(Job $job, string $errorCode): void
    {
        $error = substr($errorCode, 0, 500);
        if ($this->run('SELECT 1 FROM job WHERE id = ? AND cancel_requested_at IS NOT NULL', [$job->id])->fetchColumn() !== false) {
            $this->run("UPDATE job SET state = 'cancelled', run_at = UTC_TIMESTAMP(6), last_error = ? WHERE id = ?", [$error, $job->id]);

            return;
        }
        if ($job->attempts >= self::MAX_ATTEMPTS) {
            // run_at records when the job finally failed (the CONDSTORE flag sync compares it).
            $this->run("UPDATE job SET state = 'failed', run_at = UTC_TIMESTAMP(6), last_error = ? WHERE id = ?", [$error, $job->id]);

            return;
        }
        $backoff = min(self::BACKOFF_BASE_SECONDS * 2 ** ($job->attempts - 1), self::BACKOFF_MAX_SECONDS);
        $this->run(
            "UPDATE job SET state = 'queued', run_at = UTC_TIMESTAMP(6) + INTERVAL ? SECOND, last_error = ? WHERE id = ?",
            [$backoff, $error, $job->id],
        );
    }

    /**
     * Re-queues jobs stuck in 'running' (the process died, e.g. killed by
     * max_execution_time); jobs out of attempts go to 'failed'.
     *
     * @return list<Job> the jobs that were given up
     */
    public function requeueStale(int $staleSeconds): array
    {
        $pdo = $this->db->pdo();
        $pdo->beginTransaction();
        try {
            $rows = Database::run(
                $pdo,
                "SELECT id, type, account_id, payload, attempts, cancel_requested_at IS NOT NULL AS cancel FROM job
                 WHERE state = 'running' AND locked_at <= UTC_TIMESTAMP(6) - INTERVAL ? SECOND FOR UPDATE",
                [$staleSeconds],
            )->fetchAll();
            $givenUp = [];
            foreach ($rows as $row) {
                /** @var array{id: int|string, type: string, account_id: ?string, payload: string, attempts: int|string, cancel: int|string} $row */
                $failed = (int) $row['attempts'] >= self::MAX_ATTEMPTS;
                // A lost job that was asked to cancel stays stopped.
                $state = (int) $row['cancel'] === 1 ? 'cancelled' : ($failed ? 'failed' : 'queued');
                Database::run(
                    $pdo,
                    "UPDATE job SET state = ?, last_error = IF(?, 'WORKER_LOST', last_error), run_at = UTC_TIMESTAMP(6), locked_at = NULL WHERE id = ?",
                    [$state, $failed ? 1 : 0, $row['id']],
                );
                if ($failed) {
                    $payload = json_decode($row['payload'], true);
                    $givenUp[] = new Job((string) $row['id'], $row['type'], $row['account_id'], \is_array($payload) ? $payload : [], (int) $row['attempts']);
                }
            }
            $pdo->commit();

            return $givenUp;
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }
    }

    /**
     * Enqueues folder_sync for every due account; returns how many. No
     * pile-up (nothing queued/running), longer interval after a terminal
     * failure, skips accounts in auth_error/disabled/backoff.
     */
    public function enqueueDueSyncs(int $intervalSeconds): int
    {
        return $this->run(
            "INSERT INTO job (type, account_id, payload)
             SELECT 'folder_sync', ma.id, '{}' FROM mail_account ma
             WHERE ma.status NOT IN ('disabled', 'auth_error')
               AND (ma.next_retry_at IS NULL OR ma.next_retry_at <= UTC_TIMESTAMP(6))
               AND NOT EXISTS (
                 SELECT 1 FROM job j WHERE j.type = 'folder_sync' AND j.account_id = ma.id
                   AND j.state IN ('queued', 'running'))
               AND NOT EXISTS (
                 SELECT 1 FROM job j WHERE j.type = 'folder_sync' AND j.account_id = ma.id
                   AND j.created_at > UTC_TIMESTAMP(6) - INTERVAL (CASE WHEN j.state = 'failed' THEN ? ELSE ? END) SECOND)",
            [max($intervalSeconds, self::FAILED_RETRY_INTERVAL_SECONDS), $intervalSeconds],
        )->rowCount();
    }

    /**
     * Enqueues message_sync for a folder unless one is queued or running;
     * `minIntervalSeconds` debounces IDLE bursts (no earlier than that after
     * the start of the folder's last finished sync).
     */
    public function enqueueMessageSync(string $accountId, string $folderId, int $minIntervalSeconds = 0): bool
    {
        return $this->run(
            "INSERT INTO job (type, account_id, payload, run_at)
             SELECT 'message_sync', ?, JSON_OBJECT('folderId', ?),
               GREATEST(UTC_TIMESTAMP(6), COALESCE((
                 SELECT MAX(d.locked_at) FROM job d
                 WHERE d.type = 'message_sync' AND d.account_id = ? AND d.state = 'done'
                   AND JSON_UNQUOTE(JSON_EXTRACT(d.payload, '$.folderId')) = ?
               ) + INTERVAL ? SECOND, UTC_TIMESTAMP(6)))
             FROM DUAL
             WHERE NOT EXISTS (
               SELECT 1 FROM job q
               WHERE q.type = 'message_sync' AND q.account_id = ? AND q.state IN ('queued', 'running')
                 AND JSON_UNQUOTE(JSON_EXTRACT(q.payload, '$.folderId')) = ?)",
            [$accountId, $folderId, $accountId, $folderId, $minIntervalSeconds, $accountId, $folderId],
        )->rowCount() > 0;
    }

    /**
     * Cancels the syncs of an account (#119): queued sync jobs end as
     * 'cancelled' (so the folder_sync -> message_sync chain stops), running
     * ones are asked to stop. Locks the account row like chainUnlessCancelled(),
     * so a running folder_sync cannot chain new jobs past the cancel.
     *
     * @return array{cancelledQueued: int, cancelling: bool}
     */
    public function cancelSyncs(string $accountId): array
    {
        $pdo = $this->db->pdo();
        $pdo->beginTransaction();
        try {
            $types = "'" . implode("', '", self::SYNC_TYPES) . "'";
            Database::run($pdo, 'SELECT 1 FROM mail_account WHERE id = ? FOR UPDATE', [$accountId]);
            $queued = Database::run(
                $pdo,
                "UPDATE job SET state = 'cancelled', cancel_requested_at = UTC_TIMESTAMP(6), run_at = UTC_TIMESTAMP(6)
                 WHERE account_id = ? AND state = 'queued' AND type IN ({$types})",
                [$accountId],
            )->rowCount();
            Database::run(
                $pdo,
                "UPDATE job SET cancel_requested_at = UTC_TIMESTAMP(6)
                 WHERE account_id = ? AND state = 'running' AND type IN ({$types}) AND cancel_requested_at IS NULL",
                [$accountId],
            );
            $running = Database::run(
                $pdo,
                "SELECT 1 FROM job WHERE account_id = ? AND state = 'running' AND type IN ({$types}) LIMIT 1",
                [$accountId],
            )->fetchColumn() !== false;
            $pdo->commit();

            return ['cancelledQueued' => $queued, 'cancelling' => $running];
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
    }

    /**
     * Runs `$enqueue` (follow-up jobs of a running sync) unless the job was
     * asked to cancel; serialized with cancelSyncs() by the account row
     * lock, so nothing is chained after a cancel. Returns whether it ran.
     *
     * @param callable(): mixed $enqueue
     */
    public function chainUnlessCancelled(Job $job, callable $enqueue): bool
    {
        $pdo = $this->db->pdo();
        $pdo->beginTransaction();
        try {
            Database::run($pdo, 'SELECT 1 FROM mail_account WHERE id = ? FOR UPDATE', [$job->accountId]);
            $cancel = Database::run($pdo, 'SELECT 1 FROM job WHERE id = ? AND cancel_requested_at IS NOT NULL', [$job->id])->fetchColumn() !== false;
            if (!$cancel) {
                $enqueue();
            }
            $pdo->commit();

            return !$cancel;
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
    }

    /** Enqueues the periodic cleanup job unless one is pending or recent. */
    public function enqueueDueCleanup(int $intervalSeconds): bool
    {
        return $this->run(
            "INSERT INTO job (type, payload) SELECT 'cleanup', '{}' FROM DUAL
             WHERE NOT EXISTS (
               SELECT 1 FROM job WHERE type = 'cleanup'
                 AND (state IN ('queued', 'running') OR created_at > UTC_TIMESTAMP(6) - INTERVAL ? SECOND))",
            [$intervalSeconds],
        )->rowCount() > 0;
    }

    /**
     * Coalesced draft_sync (roadmap 2.8): while a job for the draft is
     * queued, only move its run_at forward; a running job does not count.
     */
    public function enqueueDraftSync(string $accountId, string $draftId, int $delaySeconds = 0): void
    {
        $delay = max(0, $delaySeconds);
        $moved = $this->run(
            "UPDATE job SET run_at = LEAST(run_at, UTC_TIMESTAMP(6) + INTERVAL ? SECOND)
             WHERE type = 'draft_sync' AND account_id = ? AND state = 'queued'
               AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.draftId')) = ?",
            [$delay, $accountId, $draftId],
        )->rowCount();
        // rowCount counts changed rows: an equal run_at is "found but unchanged".
        $exists = $moved > 0 || $this->run(
            "SELECT 1 FROM job WHERE type = 'draft_sync' AND account_id = ? AND state = 'queued'
               AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.draftId')) = ? LIMIT 1",
            [$accountId, $draftId],
        )->fetchColumn() !== false;
        if (!$exists) {
            $this->enqueue('draft_sync', $accountId, ['draftId' => $draftId], $delay);
        }
    }
}
