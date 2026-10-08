<?php

declare(strict_types=1);

namespace Fma\Jobs;

use Fma\Db\Database;

/**
 * Account circuit breaker:
 * - auth errors: status 'auth_error', no automatic retry until the
 *   credentials change (PATCH /api/accounts/{id} resets it);
 * - unreachable/throttled: backoff via next_retry_at, 1 min doubling up to
 *   1 h; status 'unreachable' after 3 consecutive failures; failures inside
 *   an open window do not count twice;
 * - a successful sync closes the circuit.
 */
final class AccountHealth
{
    public const CIRCUIT_OPEN_AFTER = 3;
    private const BACKOFF_BASE_SECONDS = 60;
    private const BACKOFF_MAX_SECONDS = 3600;

    public function __construct(private readonly Database $db) {}

    public function recordSuccess(string $accountId): void
    {
        Database::run(
            $this->db->pdo(),
            "UPDATE mail_account SET status = 'ok', error_count = 0, next_retry_at = NULL, last_error_code = NULL,
               last_sync_at = UTC_TIMESTAMP(6)
             WHERE id = ? AND status <> 'disabled'",
            [$accountId],
        );
    }

    /** @return array{status: string, errorCount: int, nextRetryAt: ?string}|null */
    public function recordFailure(string $accountId, AccountErrorException $error): ?array
    {
        $pdo = $this->db->pdo();
        $pdo->beginTransaction();
        try {
            /** @var array{status: string, error_count: int|string, window_open: int|string}|false $row */
            $row = Database::run(
                $pdo,
                "SELECT status, error_count, (next_retry_at IS NOT NULL AND next_retry_at > UTC_TIMESTAMP(6)) AS window_open
                 FROM mail_account WHERE id = ? AND status <> 'disabled' FOR UPDATE",
                [$accountId],
            )->fetch();
            if ($row === false) {
                $pdo->rollBack();

                return null;
            }
            $count = (int) $row['error_count'] + ((int) $row['window_open'] === 1 ? 0 : 1);
            $auth = $error->kind() === 'auth';
            $status = match (true) {
                $auth => 'auth_error',
                $row['status'] === 'auth_error' => 'auth_error',
                $count >= self::CIRCUIT_OPEN_AFTER => 'unreachable',
                default => $row['status'],
            };
            $backoff = $auth ? null : min(self::BACKOFF_BASE_SECONDS * 2 ** ($count - 1), self::BACKOFF_MAX_SECONDS);
            Database::run(
                $pdo,
                'UPDATE mail_account SET error_count = ?, last_error_code = ?, status = ?,
                   next_retry_at = IF(? IS NULL, NULL, UTC_TIMESTAMP(6) + INTERVAL ? SECOND)
                 WHERE id = ?',
                [$count, $error->errorCode, $status, $backoff, $backoff ?? 0, $accountId],
            );
            $next = Database::run($pdo, 'SELECT next_retry_at FROM mail_account WHERE id = ?', [$accountId])->fetchColumn();
            $pdo->commit();

            return ['status' => $status, 'errorCount' => $count, 'nextRetryAt' => \is_string($next) ? $next : null];
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
    }
}
