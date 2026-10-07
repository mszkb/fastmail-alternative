<?php

declare(strict_types=1);

namespace Fma\Routes;

use Fma\Auth\Session;
use Fma\Auth\Sessions;
use Fma\Config;
use Fma\Db\Database;
use Fma\Db\Uuid;
use Fma\Http\Json;
use Fma\Http\Middleware\RequireAuth;
use Fma\Jobs\JobQueue;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\App;

/**
 * Client-triggered sync like apps/api/src/mail/sync.ts (roadmap 4.5): the
 * app asks for a sync on start, focus and when it comes back online.
 *
 * - POST /api/accounts/{id}/sync: folder_sync for one account;
 *   POST /api/sync: for all accounts of the user.
 * - Same rules as the scheduler: no job for disabled accounts, auth_error,
 *   an open circuit (next_retry_at in the future), or while a folder_sync
 *   is queued or running.
 * - Rate limit per account: none when the last folder_sync (any source)
 *   was created less than SYNC_REQUEST_MIN_INTERVAL_SECONDS ago - stored
 *   in the job table, so it holds across devices. A folder_sync the user
 *   stopped does not count, so "Jetzt synchronisieren" works right after
 *   "Stoppen".
 *
 * The account rows are locked (FOR UPDATE) while checking and enqueueing,
 * so concurrent requests cannot both enqueue.
 *
 * Sync status and stopping (#119):
 * - GET /api/sync/status: per account state, phase, folder id, done/total,
 *   start, last success, next scheduled run and last error code - ids,
 *   numbers and codes only (principles 5/6); the client resolves folder
 *   names itself. One grouped select, cheap enough to poll every 2-3 s
 *   while a sync runs.
 * - POST /api/accounts/{id}/sync/cancel, POST /api/sync/cancel: queued
 *   sync jobs end as 'cancelled', running ones stop cooperatively between
 *   batches (JobQueue::cancelSyncs). Other accounts are not touched; the
 *   scheduler starts the account again at its next regular time.
 */
final class SyncRoutes
{
    public const SYNC_REQUEST_MIN_INTERVAL_SECONDS = 30;
    /** Retry interval after a failed folder_sync, like JobQueue::enqueueDueSyncs(). */
    private const FAILED_RETRY_INTERVAL_SECONDS = 3600;

    public function __construct(
        private readonly Database $db,
        private readonly JobQueue $jobs,
        private readonly ?Config $config = null,
    ) {}

    /** @param App<\Psr\Container\ContainerInterface|null> $app */
    public function register(App $app, RequireAuth $requireAuth): void
    {
        $app->post('/api/accounts/{id}/sync', $this->syncOne(...))->add($requireAuth);
        $app->post('/api/sync', $this->syncAll(...))->add($requireAuth);
        $app->get('/api/sync/status', $this->status(...))->add($requireAuth);
        $app->post('/api/accounts/{id}/sync/cancel', $this->cancelOne(...))->add($requireAuth);
        $app->post('/api/sync/cancel', $this->cancelAll(...))->add($requireAuth);
    }

    /**
     * Enqueues folder_sync for the account (or all accounts of the user)
     * where allowed. One result per account; empty: no such account.
     *
     * @return list<array{accountId: string, queued: bool, reason: ?string}>
     */
    public function requestSync(string $userId, ?string $accountId, int $minIntervalSeconds = self::SYNC_REQUEST_MIN_INTERVAL_SECONDS): array
    {
        $pdo = $this->db->pdo();
        $pdo->beginTransaction();
        try {
            /** @var list<array{id: string, status: string, backoff: int|string, pending: int|string, recent: int|string}> $rows */
            $rows = Database::run(
                $pdo,
                "SELECT ma.id, ma.status,
                   (ma.next_retry_at IS NOT NULL AND ma.next_retry_at > UTC_TIMESTAMP(6)) AS backoff,
                   EXISTS (
                     SELECT 1 FROM job j WHERE j.type = 'folder_sync' AND j.account_id = ma.id
                       AND j.state IN ('queued', 'running')
                   ) AS pending,
                   EXISTS (
                     SELECT 1 FROM job j WHERE j.type = 'folder_sync' AND j.account_id = ma.id
                       AND j.state <> 'cancelled' AND j.created_at > UTC_TIMESTAMP(6) - INTERVAL ? SECOND
                   ) AS recent
                 FROM mail_account ma
                 WHERE ma.user_id = ? AND (? IS NULL OR ma.id = ?)
                 ORDER BY ma.sort_order, ma.created_at
                 FOR UPDATE",
                [$minIntervalSeconds, $userId, $accountId, $accountId],
            )->fetchAll();
            $results = [];
            foreach ($rows as $row) {
                // Same order of checks as Node's skipReason.
                $reason = match (true) {
                    $row['status'] === 'disabled' => 'disabled',
                    $row['status'] === 'auth_error' => 'auth_error',
                    (bool) $row['backoff'] => 'backoff',
                    (bool) $row['pending'] => 'pending',
                    (bool) $row['recent'] => 'rate_limited',
                    default => null,
                };
                if ($reason === null) {
                    $this->jobs->enqueue('folder_sync', $row['id']);
                }
                $results[] = ['accountId' => $row['id'], 'queued' => $reason === null, 'reason' => $reason];
            }
            $pdo->commit();

            return $results;
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
    }

    /** @param array<string, string> $args */
    private function syncOne(Request $request, Response $response, array $args): Response
    {
        $accountId = strtolower($args['id'] ?? '');
        $result = Uuid::isValid($accountId) ? ($this->requestSync(self::session($request)->userId, $accountId)[0] ?? null) : null;
        if ($result === null) {
            return Json::write($response, ['message' => 'Konto nicht gefunden.'], 404);
        }
        if ($result['reason'] === 'rate_limited') {
            return Json::write($response, $result, 429)->withHeader('Retry-After', (string) self::SYNC_REQUEST_MIN_INTERVAL_SECONDS);
        }

        // 202: queued for the worker; 200: nothing to do (reason says why).
        return Json::write($response, $result, $result['queued'] ? 202 : 200);
    }

    /** All accounts at once (app start/focus): rate-limited accounts are only reported. */
    private function syncAll(Request $request, Response $response): Response
    {
        return Json::write($response, ['accounts' => $this->requestSync(self::session($request)->userId, null)]);
    }

    /**
     * Sync state of every account of the user (#119).
     *
     * @return list<array<string, mixed>>
     */
    public function syncStatus(string $userId): array
    {
        $types = "'" . implode("', '", JobQueue::SYNC_TYPES) . "'";
        $rows = Database::run(
            $this->db->pdo(),
            "SELECT ma.id, ma.status, ma.last_error_code, ma.last_sync_at, ma.next_retry_at,
               (ma.next_retry_at IS NOT NULL AND ma.next_retry_at > UTC_TIMESTAMP(6)) AS backoff,
               r.progress_phase, r.progress_folder_id, r.progress_done, r.progress_total, r.locked_at,
               r.progress_updated_at, r.cancel_requested_at, r.id AS running_job,
               COALESCE(q.queued, 0) AS queued, COALESCE(q.due, 0) AS due, q.next_run_at,
               l.last_created, l.last_failed, UTC_TIMESTAMP(6) AS now
             FROM mail_account ma
             LEFT JOIN job r ON r.account_id = ma.id AND r.state = 'running' AND r.type IN ({$types})
             LEFT JOIN (
               SELECT account_id, COUNT(*) AS queued, SUM(run_at <= UTC_TIMESTAMP(6)) AS due, MIN(run_at) AS next_run_at
               FROM job WHERE state = 'queued' AND type IN ({$types}) GROUP BY account_id
             ) q ON q.account_id = ma.id
             LEFT JOIN (
               SELECT account_id, MAX(created_at) AS last_created, MAX(IF(state = 'failed', created_at, NULL)) AS last_failed
               FROM job WHERE type = 'folder_sync' GROUP BY account_id
             ) l ON l.account_id = ma.id
             WHERE ma.user_id = ?
             ORDER BY ma.sort_order, ma.created_at, r.id",
            [$userId],
        )->fetchAll();
        $interval = max(1, $this->config?->int('SYNC_INTERVAL_SECONDS', 120) ?? 120);
        $accounts = [];
        foreach ($rows as $row) {
            /** @var array{id: string, status: string, last_error_code: ?string, last_sync_at: ?string, next_retry_at: ?string, backoff: int|string, progress_phase: ?string, progress_folder_id: ?string, progress_done: int|string|null, progress_total: int|string|null, locked_at: ?string, progress_updated_at: ?string, cancel_requested_at: ?string, running_job: int|string|null, queued: int|string, due: int|string, next_run_at: ?string, last_created: ?string, last_failed: ?string, now: string} $row */
            if (isset($accounts[$row['id']])) {
                continue; // at most one running job per account; never two rows
            }
            $running = $row['running_job'] !== null;
            $state = match (true) {
                $row['status'] === 'auth_error' => 'auth_error',
                $row['status'] === 'disabled' => 'paused',
                $running && $row['cancel_requested_at'] !== null => 'cancelling',
                $running => 'running',
                (bool) $row['backoff'] => 'error',
                (int) $row['due'] > 0 => 'queued',
                $row['status'] === 'unreachable' => 'error',
                default => 'idle',
            };
            $accounts[$row['id']] = [
                'accountId' => $row['id'],
                'state' => $state,
                'phase' => $running ? $row['progress_phase'] : null,
                'folderId' => $running ? $row['progress_folder_id'] : null,
                'done' => $running && $row['progress_done'] !== null ? (int) $row['progress_done'] : null,
                'total' => $running && $row['progress_total'] !== null ? (int) $row['progress_total'] : null,
                'startedAt' => $running ? Sessions::iso($row['locked_at']) : null,
                'updatedAt' => $running ? Sessions::iso($row['progress_updated_at']) : null,
                'queuedJobs' => (int) $row['queued'],
                'lastSyncAt' => Sessions::iso($row['last_sync_at']),
                'nextRunAt' => Sessions::iso(self::nextRun($state, $row, $interval)),
                'lastErrorCode' => $row['last_error_code'],
            ];
        }

        return array_values($accounts);
    }

    /**
     * Earliest time the scheduler (or a queued job) syncs the account next;
     * cron runs once a minute, so the real start can be a little later.
     *
     * @param array{next_retry_at: ?string, next_run_at: ?string, last_created: ?string, last_failed: ?string, now: string} $row
     */
    private static function nextRun(string $state, array $row, int $interval): ?string
    {
        if (\in_array($state, ['auth_error', 'paused', 'running', 'cancelling'], true)) {
            return null;
        }
        if ($state === 'error' && $row['next_retry_at'] !== null) {
            return $row['next_retry_at'];
        }
        $candidates = [$row['now']];
        if ($row['next_run_at'] !== null) {
            $candidates[] = $row['next_run_at'];
        } else {
            $utc = new \DateTimeZone('UTC');
            foreach ([[$row['last_created'], $interval], [$row['last_failed'], max($interval, self::FAILED_RETRY_INTERVAL_SECONDS)]] as [$at, $seconds]) {
                if ($at !== null) {
                    $candidates[] = (new \DateTimeImmutable($at, $utc))->modify("+{$seconds} seconds")->format('Y-m-d H:i:s.u');
                }
            }
        }

        return max($candidates);
    }

    private function status(Request $request, Response $response): Response
    {
        return Json::write($response, ['accounts' => $this->syncStatus(self::session($request)->userId)]);
    }

    /**
     * Stops the syncs of the account (or all accounts of the user).
     *
     * @return list<array{accountId: string, cancelledQueued: int, cancelling: bool}>
     */
    public function cancelSync(string $userId, ?string $accountId): array
    {
        $ids = Database::run(
            $this->db->pdo(),
            'SELECT id FROM mail_account WHERE user_id = ? AND (? IS NULL OR id = ?) ORDER BY sort_order, created_at',
            [$userId, $accountId, $accountId],
        )->fetchAll(\PDO::FETCH_COLUMN);
        $results = [];
        foreach ($ids as $id) {
            $results[] = ['accountId' => (string) $id] + $this->jobs->cancelSyncs((string) $id);
        }

        return $results;
    }

    /** @param array<string, string> $args */
    private function cancelOne(Request $request, Response $response, array $args): Response
    {
        $accountId = strtolower($args['id'] ?? '');
        $result = Uuid::isValid($accountId) ? ($this->cancelSync(self::session($request)->userId, $accountId)[0] ?? null) : null;
        if ($result === null) {
            return Json::write($response, ['message' => 'Konto nicht gefunden.'], 404);
        }

        return Json::write($response, $result);
    }

    private function cancelAll(Request $request, Response $response): Response
    {
        return Json::write($response, ['accounts' => $this->cancelSync(self::session($request)->userId, null)]);
    }

    private static function session(Request $request): Session
    {
        $session = $request->getAttribute('auth');
        if (!$session instanceof Session) {
            throw new \LogicException('route without RequireAuth');
        }

        return $session;
    }
}
