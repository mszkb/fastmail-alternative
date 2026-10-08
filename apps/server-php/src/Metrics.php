<?php

declare(strict_types=1);

namespace Fma;

use Fma\Db\Database;

/**
 * Prometheus metrics, kept in the table
 * `metric_counter` (no process memory between PHP requests). Only recorded
 * when METRICS_TOKEN is set. Process gauges (RSS, uptime) do not exist for
 * PHP requests and are omitted.
 */
final class Metrics
{
    public const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

    public function __construct(private readonly Database $db) {}

    public function recordRequest(string $method, string $route, int $status, float $seconds): void
    {
        $labels = \sprintf('{method="%s",route="%s",status="%d"}', self::label($method), self::label($route), $status);
        $increments = ["http_requests_total{$labels}" => 1.0];
        foreach (self::DURATION_BUCKETS as $le) {
            if ($seconds <= $le) {
                $increments["http_request_duration_seconds_bucket{le=\"{$le}\"}"] = 1.0;
            }
        }
        $increments['http_request_duration_seconds_bucket{le="+Inf"}'] = 1.0;
        $increments['http_request_duration_seconds_sum'] = $seconds;
        $increments['http_request_duration_seconds_count'] = 1.0;

        $placeholders = implode(', ', array_fill(0, \count($increments), '(?, ?)'));
        $params = [];
        foreach ($increments as $name => $value) {
            $params[] = $name;
            $params[] = $value;
        }
        $this->db->pdo()
            // VALUES(): the row alias syntax (AS new) does not exist in MariaDB.
            ->prepare("INSERT INTO metric_counter (name, value) VALUES {$placeholders}
                       ON DUPLICATE KEY UPDATE value = value + VALUES(value)")
            ->execute($params);
    }

    public function render(): string
    {
        $rows = Database::run($this->db->pdo(), 'SELECT name, value FROM metric_counter ORDER BY name')->fetchAll(\PDO::FETCH_KEY_PAIR);
        $requests = [];
        $durations = [];
        foreach ($rows as $name => $value) {
            $line = $name . ' ' . self::number((float) $value);
            if (str_starts_with((string) $name, 'http_requests_total')) {
                $requests[] = $line;
            } else {
                $durations[] = $line;
            }
        }
        usort($durations, static fn(string $a, string $b): int => self::bucketOrder($a) <=> self::bucketOrder($b));

        return implode("\n", [
            '# HELP http_requests_total Total HTTP requests.',
            '# TYPE http_requests_total counter',
            ...$requests,
            '# HELP http_request_duration_seconds HTTP request duration in seconds.',
            '# TYPE http_request_duration_seconds histogram',
            ...$durations,
        ]) . "\n";
    }

    /**
     * Buckets ascending by `le`, then _sum, then _count (Prometheus text format order).
     *
     * @return array{int, float}
     */
    private static function bucketOrder(string $line): array
    {
        if (preg_match('/le="([^"]+)"/', $line, $m) === 1) {
            return [0, $m[1] === '+Inf' ? INF : (float) $m[1]];
        }

        return [str_contains($line, '_sum') ? 1 : 2, 0.0];
    }

    private static function number(float $value): string
    {
        return $value == floor($value) && abs($value) < 1e15 ? (string) (int) $value : (string) $value;
    }

    private static function label(string $value): string
    {
        return str_replace(['\\', '"', "\n"], ['\\\\', '\\"', '\\n'], $value);
    }
}
