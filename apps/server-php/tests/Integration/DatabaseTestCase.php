<?php

declare(strict_types=1);

namespace Fma\Tests\Integration;

use Fma\Config;
use Fma\Db\Database;
use Fma\Db\Migrator;
use PHPUnit\Framework\TestCase;

/**
 * Base for tests against MySQL/MariaDB. Needs DATABASE_URL pointing to a
 * throwaway database (it is wiped); skipped without it (GitHub CI runs
 * unit tests only, the nightly provides a database).
 */
abstract class DatabaseTestCase extends TestCase
{
    protected static Config $config;
    protected static Database $db;

    public static function setUpBeforeClass(): void
    {
        $url = getenv('DATABASE_URL');
        if (!\is_string($url) || $url === '') {
            self::markTestSkipped('DATABASE_URL not set');
        }
        self::$config = Config::fromArray(['DATABASE_URL' => $url]);
        self::$db = new Database(self::$config);
        $pdo = self::$db->pdo();
        $pdo->exec('SET FOREIGN_KEY_CHECKS = 0');
        foreach (Database::run($pdo, 'SHOW TABLES')->fetchAll(\PDO::FETCH_COLUMN) as $table) {
            $pdo->exec("DROP TABLE `{$table}`");
        }
        $pdo->exec('SET FOREIGN_KEY_CHECKS = 1');
        (new Migrator($pdo, __DIR__ . '/../../migrations'))->migrate();
    }
}
