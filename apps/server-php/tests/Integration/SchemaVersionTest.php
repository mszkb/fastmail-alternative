<?php

declare(strict_types=1);

namespace Fma\Tests\Integration;

use Fma\Db\Database;
use Fma\Db\Migrator;
use Fma\Db\SchemaTooNewException;

/** The migrator refuses a database a newer version has migrated. */
final class SchemaVersionTest extends DatabaseTestCase
{
    private const FUTURE = '9999_from_a_newer_version';

    protected function tearDown(): void
    {
        Database::run(self::$db->pdo(), 'DELETE FROM schema_migrations WHERE name = ?', [self::FUTURE]);
    }

    public function testRefusesUnknownMigrations(): void
    {
        Database::run(self::$db->pdo(), 'INSERT INTO schema_migrations (name) VALUES (?)', [self::FUTURE]);
        try {
            (new Migrator(self::$db->pdo(), __DIR__ . '/../../migrations'))->migrate();
            self::fail('expected SchemaTooNewException');
        } catch (SchemaTooNewException $e) {
            self::assertSame([self::FUTURE], $e->unknown);
            self::assertStringContainsString(self::FUTURE, $e->getMessage());
        }
        // The lock is released again.
        self::assertSame(1, (int) Database::run(self::$db->pdo(), "SELECT IS_FREE_LOCK('fma-migrations')")->fetchColumn());
    }
}
