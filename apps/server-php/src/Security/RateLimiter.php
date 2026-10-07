<?php

declare(strict_types=1);

namespace Fma\Security;

use Fma\Db\Database;

/**
 * Rate limits per client IP in fixed one-minute windows (ADR-0013: a
 * table instead of process memory, since PHP keeps no state between
 * requests). Table `rate_limit`, see migrations.
 */
final class RateLimiter
{
    public const WINDOW_SECONDS = 60;

    /** @param list<RateLimitRule> $rules */
    public function __construct(private readonly Database $db, private readonly array $rules) {}

    /** Counts the request; returns seconds to wait when a limit is exceeded, else 0. */
    public function hit(string $method, string $route, string $ip, ?int $now = null): int
    {
        $now ??= time();
        $window = intdiv($now, self::WINDOW_SECONDS) * self::WINDOW_SECONDS;
        $retryAfter = 0;
        $counted = [];
        foreach ($this->rules as $rule) {
            if (!$rule->matches($method, $route) || isset($counted[$rule->name])) {
                continue;
            }
            $counted[$rule->name] = true;
            if (!isset($upsert, $select)) {
                $pdo = $this->db->pdo();
                $upsert = $pdo->prepare(
                    'INSERT INTO rate_limit (bucket, ip, window_start, hits) VALUES (?, ?, ?, 1)
                     ON DUPLICATE KEY UPDATE hits = hits + 1',
                );
                $select = $pdo->prepare('SELECT hits FROM rate_limit WHERE bucket = ? AND ip = ? AND window_start = ?');
            }
            $upsert->execute([$rule->name, $ip, $window]);
            $select->execute([$rule->name, $ip, $window]);
            $hits = (int) $select->fetchColumn();
            if ($hits > $rule->max) {
                $retryAfter = max($retryAfter, $window + self::WINDOW_SECONDS - $now);
            }
        }
        // Old windows are useless; prune now and then instead of on every request.
        if ($counted !== [] && random_int(1, 100) === 1) {
            $this->prune($now);
        }

        return $retryAfter;
    }

    public function prune(?int $now = null): void
    {
        $window = intdiv($now ?? time(), self::WINDOW_SECONDS) * self::WINDOW_SECONDS;
        $this->db->pdo()->prepare('DELETE FROM rate_limit WHERE window_start < ?')->execute([$window]);
    }
}
