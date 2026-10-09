<?php

declare(strict_types=1);

namespace Fma\Push;

use Fma\Db\Database;

/**
 * Enqueues push_notify: called by
 * message_sync when new unseen messages arrive in an INBOX (incremental
 * sync only). At most one queued job per user, jobs of a user at least
 * COALESCE_SECONDS apart (a burst over several accounts yields one
 * notification), and only when the user has an active subscription. The
 * job has no account_id (it is per user), the payload holds the user id.
 */
final class PushNotifyQueue
{
    /** Minimum distance between two push jobs of a user. */
    public const COALESCE_SECONDS = 30;

    public function __construct(private readonly Database $db) {}

    /** Returns true when a job was created. Callers treat failures as best effort (push is only a hint). */
    public function enqueueForAccount(string $accountId): bool
    {
        return $this->enqueue('SELECT ma.user_id AS user_id FROM mail_account ma WHERE ma.id = ?', $accountId);
    }

    /**
     * Test notification from the app's settings (POST /api/push/test): the
     * same content-free push_notify job, with the same coalescing, so it
     * cannot be used to flood a device.
     */
    public function enqueueForUser(string $userId): bool
    {
        return $this->enqueue('SELECT u.id AS user_id FROM `user` u WHERE u.id = ?', $userId);
    }

    private function enqueue(string $owner, string $id): bool
    {
        return Database::run(
            $this->db->pdo(),
            "INSERT INTO job (type, payload, run_at)
             SELECT 'push_notify', JSON_OBJECT('userId', o.user_id),
               GREATEST(UTC_TIMESTAMP(6), COALESCE((
                 SELECT MAX(j.run_at) FROM job j
                 WHERE j.type = 'push_notify' AND JSON_UNQUOTE(JSON_EXTRACT(j.payload, '$.userId')) = o.user_id
               ), UTC_TIMESTAMP(6)) + INTERVAL ? SECOND)
             FROM ({$owner}) o
             WHERE NOT EXISTS (
                 SELECT 1 FROM job j
                 WHERE j.type = 'push_notify' AND JSON_UNQUOTE(JSON_EXTRACT(j.payload, '$.userId')) = o.user_id
                   AND j.state = 'queued')
               AND EXISTS (
                 SELECT 1 FROM push_subscription ps JOIN device d ON d.id = ps.device_id
                 WHERE d.user_id = o.user_id AND ps.disabled_at IS NULL AND d.revoked_at IS NULL)",
            [self::COALESCE_SECONDS, $id],
        )->rowCount() > 0;
    }
}
