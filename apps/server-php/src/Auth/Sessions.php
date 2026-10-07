<?php

declare(strict_types=1);

namespace Fma\Auth;

use Fma\Db\Database;
use Fma\Db\Uuid;

/**
 * Server-side sessions on the session/device tables (ADR-0004), like
 * apps/api/src/auth/sessions.ts:
 * - the cookie carries a random token, the database only its SHA-256;
 * - absolute timeout 30 days after login (expires_at never moves);
 * - rotation after 24 h; a session not rotated for 14 days is idle and
 *   rejected (rotated_at doubles as "last activity");
 * - every session belongs to a device; revoking a device ends its sessions.
 */
final class Sessions
{
    public const TTL_SECONDS = 30 * 24 * 3600;
    public const IDLE_SECONDS = 14 * 24 * 3600;
    public const ROTATION_SECONDS = 24 * 3600;
    private const TOUCH_SECONDS = 60;

    public function __construct(private readonly Database $db) {}

    public static function generateToken(): string
    {
        return rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
    }

    public static function hashToken(string $token): string
    {
        return hash('sha256', $token, true);
    }

    /** @param list<mixed> $params */
    private function run(string $sql, array $params = []): \PDOStatement
    {
        return Database::run($this->db->pdo(), $sql, $params);
    }

    /** Creates a device and its first session; returns the token. */
    public function createDeviceWithSession(string $userId, string $deviceName, string $platform): string
    {
        $deviceId = Uuid::v4();
        $token = self::generateToken();
        $this->run(
            'INSERT INTO device (id, user_id, name, platform, installation_id, last_seen_at)
             VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(6))',
            [$deviceId, $userId, $deviceName, $platform, Uuid::v4()],
        );
        $this->run(
            'INSERT INTO session (id, device_id, token_hash, expires_at, rotated_at)
             VALUES (?, ?, ?, UTC_TIMESTAMP(6) + INTERVAL ? SECOND, UTC_TIMESTAMP(6))',
            [Uuid::v4(), $deviceId, self::hashToken($token), self::TTL_SECONDS],
        );

        return $token;
    }

    /** Resolves a token; rejects expired, idle and revoked sessions. */
    public function resolve(string $token): ?Session
    {
        /** @var array{session_id: string, rotated_at: string, device_id: string, user_id: string, email: string}|false $row */
        $row = $this->run(
            'SELECT s.id AS session_id, s.rotated_at, d.id AS device_id, u.id AS user_id, u.email
             FROM session s
             JOIN device d ON d.id = s.device_id
             JOIN `user` u ON u.id = d.user_id
             WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP(6) AND d.revoked_at IS NULL
               AND s.rotated_at > UTC_TIMESTAMP(6) - INTERVAL ? SECOND',
            [self::hashToken($token), self::IDLE_SECONDS],
        )->fetch();
        if ($row === false) {
            return null;
        }

        return new Session(
            $row['session_id'],
            $row['device_id'],
            $row['user_id'],
            $row['email'],
            new \DateTimeImmutable($row['rotated_at'], new \DateTimeZone('UTC')),
        );
    }

    public function needsRotation(Session $session, ?int $now = null): bool
    {
        return ($now ?? time()) - $session->tokenIssuedAt->getTimestamp() > self::ROTATION_SECONDS;
    }

    /** Issues a new token for the session and invalidates the old one. */
    public function rotate(string $sessionId): string
    {
        $token = self::generateToken();
        $this->run('UPDATE session SET token_hash = ?, rotated_at = UTC_TIMESTAMP(6) WHERE id = ?', [self::hashToken($token), $sessionId]);

        return $token;
    }

    /** last_seen_at at most once per minute per device; one conditional write. */
    public function touchDevice(string $deviceId): void
    {
        $this->run(
            'UPDATE device SET last_seen_at = UTC_TIMESTAMP(6)
             WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < UTC_TIMESTAMP(6) - INTERVAL ? SECOND)',
            [$deviceId, self::TOUCH_SECONDS],
        );
    }

    /**
     * Logout. A device without sessions is never used again (every login
     * creates a new device), so its push subscriptions go as well.
     */
    public function delete(string $sessionId): void
    {
        $deviceId = $this->run('SELECT device_id FROM session WHERE id = ?', [$sessionId])->fetchColumn();
        $this->run('DELETE FROM session WHERE id = ?', [$sessionId]);
        if (!\is_string($deviceId)) {
            return;
        }
        $this->run(
            'DELETE FROM push_subscription
             WHERE device_id = ? AND NOT EXISTS (SELECT 1 FROM session WHERE device_id = ?)',
            [$deviceId, $deviceId],
        );
    }

    /** @return list<array{id: string, name: string, platform: string, lastSeenAt: string|null, isCurrent: bool}> */
    public function listDevices(string $userId, string $currentDeviceId): array
    {
        $rows = $this->run(
            'SELECT id, name, platform, last_seen_at FROM device
             WHERE user_id = ? AND revoked_at IS NULL
             ORDER BY (id = ?) DESC, last_seen_at IS NULL, last_seen_at DESC',
            [$userId, $currentDeviceId],
        )->fetchAll();
        $devices = [];
        foreach ($rows as $row) {
            /** @var array{id: string, name: string, platform: string, last_seen_at: string|null} $row */
            $devices[] = [
                'id' => $row['id'],
                'name' => $row['name'],
                'platform' => $row['platform'],
                'lastSeenAt' => self::iso($row['last_seen_at']),
                'isCurrent' => $row['id'] === $currentDeviceId,
            ];
        }

        return $devices;
    }

    /** Revokes a device and ends its sessions; false if it does not exist. */
    public function revokeDevice(string $userId, string $deviceId): bool
    {
        $revoked = $this->run(
            'UPDATE device SET revoked_at = UTC_TIMESTAMP(6) WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
            [$deviceId, $userId],
        )->rowCount();
        if ($revoked === 0) {
            return false;
        }
        $this->run('DELETE FROM session WHERE device_id = ?', [$deviceId]);
        $this->run('DELETE FROM push_subscription WHERE device_id = ?', [$deviceId]);

        return true;
    }

    /**
     * Password change: new hash, every other device revoked (with sessions
     * and push subscriptions), current token rotated - in one transaction.
     */
    public function changePasswordAndEndOtherSessions(Session $session, string $passwordHash): string
    {
        $token = self::generateToken();
        $pdo = $this->db->pdo();
        $pdo->beginTransaction();
        try {
            $this->run('UPDATE `user` SET password_hash = ? WHERE id = ?', [$passwordHash, $session->userId]);
            $others = $this->run(
                'SELECT id FROM device WHERE user_id = ? AND id <> ? AND revoked_at IS NULL FOR UPDATE',
                [$session->userId, $session->deviceId],
            )->fetchAll(\PDO::FETCH_COLUMN);
            $this->run(
                'UPDATE device SET revoked_at = UTC_TIMESTAMP(6) WHERE user_id = ? AND id <> ? AND revoked_at IS NULL',
                [$session->userId, $session->deviceId],
            );
            $this->run(
                'DELETE s FROM session s JOIN device d ON d.id = s.device_id WHERE d.user_id = ? AND s.id <> ?',
                [$session->userId, $session->sessionId],
            );
            if ($others !== []) {
                $placeholders = implode(', ', array_fill(0, \count($others), '?'));
                $this->run("DELETE FROM push_subscription WHERE device_id IN ({$placeholders})", array_values($others));
            }
            $this->run('UPDATE session SET token_hash = ?, rotated_at = UTC_TIMESTAMP(6) WHERE id = ?', [self::hashToken($token), $session->sessionId]);
            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }

        return $token;
    }

    /** DATETIME(6) in UTC -> ISO 8601 with milliseconds, like Date.toISOString(). */
    public static function iso(?string $datetime): ?string
    {
        if ($datetime === null) {
            return null;
        }

        return (new \DateTimeImmutable($datetime, new \DateTimeZone('UTC')))->format('Y-m-d\TH:i:s.v\Z');
    }
}
