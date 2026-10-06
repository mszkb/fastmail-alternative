<?php

declare(strict_types=1);

namespace Fma\Db;

use Fma\Config;

/**
 * PDO connection to MySQL 8 / MariaDB 10.6+ (ADR-0013). Times are stored as
 * UTC: the session time zone is pinned to +00:00. Connects lazily, so
 * routes without database access (and the health check's error path) do
 * not fail at construction.
 */
final class Database
{
    private ?\PDO $pdo = null;

    public function __construct(private readonly Config $config) {}

    public function pdo(): \PDO
    {
        return $this->pdo ??= self::connect($this->config);
    }

    /**
     * Prepares and executes a statement. With ERRMODE_EXCEPTION failures
     * throw, so callers always get a statement back.
     *
     * @param list<mixed> $params
     */
    public static function run(\PDO $pdo, string $sql, array $params = []): \PDOStatement
    {
        $stmt = $pdo->prepare($sql);
        $stmt->execute($params);

        return $stmt;
    }

    public static function connect(Config $config): \PDO
    {
        [$dsn, $user, $password] = self::dsn($config);
        $pdo = new \PDO($dsn, $user, $password, [
            \PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION,
            \PDO::ATTR_DEFAULT_FETCH_MODE => \PDO::FETCH_ASSOC,
            \PDO::ATTR_EMULATE_PREPARES => false,
            \PDO::ATTR_STRINGIFY_FETCHES => false,
            \PDO::ATTR_TIMEOUT => 5,
        ]);
        $pdo->exec("SET time_zone = '+00:00', sql_mode = 'STRICT_ALL_TABLES,NO_ZERO_DATE,NO_ENGINE_SUBSTITUTION,ERROR_FOR_DIVISION_BY_ZERO'");

        return $pdo;
    }

    /**
     * DATABASE_URL (`mysql://user:pass@host:port/db`) or DB_HOST, DB_PORT,
     * DB_NAME, DB_USER, DB_PASSWORD.
     *
     * @return array{string, string, string}
     */
    public static function dsn(Config $config): array
    {
        $url = $config->get('DATABASE_URL');
        if ($url !== '') {
            $parts = parse_url($url);
            if ($parts === false || !\in_array($parts['scheme'] ?? '', ['mysql', 'mariadb'], true)) {
                throw new \RuntimeException('DATABASE_URL must be a mysql:// URL');
            }
            $host = $parts['host'] ?? 'localhost';
            $port = (string) ($parts['port'] ?? 3306);
            $name = ltrim($parts['path'] ?? '', '/');
            $user = rawurldecode($parts['user'] ?? '');
            $password = rawurldecode($parts['pass'] ?? '');
        } else {
            $host = $config->get('DB_HOST', 'localhost');
            $port = $config->get('DB_PORT', '3306');
            $name = $config->get('DB_NAME', 'mail');
            $user = $config->get('DB_USER', 'mail');
            $password = $config->get('DB_PASSWORD');
        }
        if ($name === '' || preg_match('/^[A-Za-z0-9_$-]+$/', $name) !== 1) {
            throw new \RuntimeException('invalid database name');
        }

        return ["mysql:host={$host};port={$port};dbname={$name};charset=utf8mb4", $user, $password];
    }
}
