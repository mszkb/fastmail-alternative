<?php

declare(strict_types=1);

namespace Fma\Security;

use Fma\Db\Database;

/**
 * Login lockout (ADR-0004), like apps/api/src/auth/lockout.ts but in the
 * table `login_lockout`: after 5 failed logins within 15 minutes the IP is
 * locked out for 15 minutes.
 */
final class LoginLockout
{
    public const WINDOW_SECONDS = 900;
    public const MAX_FAILS = 5;
    public const LOCK_SECONDS = 900;

    public function __construct(private readonly Database $db) {}

    /** Remaining lockout in seconds, or 0 if the IP may try to log in. */
    public function isLockedOut(string $ip, ?int $now = null): int
    {
        $now ??= time();
        $stmt = $this->db->pdo()->prepare('SELECT locked_until FROM login_lockout WHERE ip = ?');
        $stmt->execute([$ip]);
        $lockedUntil = (int) $stmt->fetchColumn();

        return max(0, $lockedUntil - $now);
    }

    /** Records a failed attempt; returns true when it started a lockout. */
    public function recordFail(string $ip, ?int $now = null): bool
    {
        $now ??= time();
        $pdo = $this->db->pdo();
        $pdo->beginTransaction();
        try {
            $pdo->prepare('INSERT IGNORE INTO login_lockout (ip, fails, window_start, locked_until) VALUES (?, 0, ?, 0)')
                ->execute([$ip, $now]);
            $stmt = $pdo->prepare('SELECT fails, window_start, locked_until FROM login_lockout WHERE ip = ? FOR UPDATE');
            $stmt->execute([$ip]);
            /** @var array{fails: int|string, window_start: int|string, locked_until: int|string} $row */
            $row = $stmt->fetch();
            $fails = (int) $row['fails'];
            $windowStart = (int) $row['window_start'];
            $lockedUntil = (int) $row['locked_until'];
            $started = false;
            if ($now - $windowStart > self::WINDOW_SECONDS) {
                $fails = 1;
                $windowStart = $now;
            } else {
                ++$fails;
                if ($fails >= self::MAX_FAILS && $lockedUntil <= $now) {
                    $lockedUntil = $now + self::LOCK_SECONDS;
                    $started = true;
                }
            }
            $pdo->prepare('UPDATE login_lockout SET fails = ?, window_start = ?, locked_until = ? WHERE ip = ?')
                ->execute([$fails, $windowStart, $lockedUntil, $ip]);
            $pdo->commit();

            return $started;
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }
    }

    public function recordSuccess(string $ip): void
    {
        $this->db->pdo()->prepare('DELETE FROM login_lockout WHERE ip = ?')->execute([$ip]);
    }

    /** Removes entries whose window and lock have expired (cron). */
    public function prune(?int $now = null): void
    {
        $now ??= time();
        $this->db->pdo()->prepare('DELETE FROM login_lockout WHERE window_start < ? AND locked_until < ?')
            ->execute([$now - self::WINDOW_SECONDS, $now]);
    }
}
