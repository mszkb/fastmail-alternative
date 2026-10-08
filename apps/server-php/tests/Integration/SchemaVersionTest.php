<?php

declare(strict_types=1);

namespace Fma\Tests\Integration;

use Fma\Db\Database;
use Fma\Db\Migrator;
use Fma\Db\SchemaTooNewException;
use Fma\Jobs\Bootstrap;
use Fma\Log\Logger;
use Fma\Tests\Support\Http;

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

    public function testJobRunnersRefuseANewerSchema(): void
    {
        (new Migrator(self::$db->pdo()))->assertNotNewer();
        Database::run(self::$db->pdo(), 'INSERT INTO schema_migrations (name) VALUES (?)', [self::FUTURE]);
        try {
            Bootstrap::runner(self::$config, new Logger('cron', 'error', Http::memoryStream()), self::$db);
            self::fail('expected SchemaTooNewException');
        } catch (SchemaTooNewException $e) {
            self::assertSame([self::FUTURE], $e->unknown);
        }

        // bin/cron.php logs the refusal and exits non-zero without running jobs.
        $process = proc_open(
            [\PHP_BINARY, __DIR__ . '/../../bin/cron.php'],
            [1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
            $pipes,
            null,
            ['DATABASE_URL' => self::$config->get('DATABASE_URL'), 'LOG_LEVEL' => 'info'] + getenv(),
        );
        self::assertIsResource($process);
        $output = (string) stream_get_contents($pipes[1]) . (string) stream_get_contents($pipes[2]);
        self::assertSame(1, proc_close($process));
        self::assertStringContainsString('jobs refused', $output);
        self::assertStringContainsString(self::FUTURE, $output);
    }
}
