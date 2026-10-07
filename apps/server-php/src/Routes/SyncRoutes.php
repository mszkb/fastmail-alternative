<?php

declare(strict_types=1);

namespace Fma\Routes;

use Fma\Auth\Session;
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
 *   in the job table, so it holds across devices.
 *
 * The account rows are locked (FOR UPDATE) while checking and enqueueing,
 * so concurrent requests cannot both enqueue.
 */
final class SyncRoutes
{
    public const SYNC_REQUEST_MIN_INTERVAL_SECONDS = 30;

    public function __construct(private readonly Database $db, private readonly JobQueue $jobs) {}

    /** @param App<\Psr\Container\ContainerInterface|null> $app */
    public function register(App $app, RequireAuth $requireAuth): void
    {
        $app->post('/api/accounts/{id}/sync', $this->syncOne(...))->add($requireAuth);
        $app->post('/api/sync', $this->syncAll(...))->add($requireAuth);
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
                       AND j.created_at > UTC_TIMESTAMP(6) - INTERVAL ? SECOND
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

    private static function session(Request $request): Session
    {
        $session = $request->getAttribute('auth');
        if (!$session instanceof Session) {
            throw new \LogicException('route without RequireAuth');
        }

        return $session;
    }
}
