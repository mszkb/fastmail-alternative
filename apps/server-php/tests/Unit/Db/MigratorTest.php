<?php

declare(strict_types=1);

namespace Fma\Tests\Unit\Db;

use Fma\Db\Migrator;
use PHPUnit\Framework\TestCase;

final class MigratorTest extends TestCase
{
    public function testSplitsStatementsAndDropsComments(): void
    {
        $sql = "-- comment;\nCREATE TABLE a (\n  x INT -- trailing\n);\n\nINSERT INTO a VALUES (1);\n";
        self::assertSame(["CREATE TABLE a (\n  x INT -- trailing\n)", 'INSERT INTO a VALUES (1)'], Migrator::statements($sql));
    }

    public function testMigrationFilesAreNamedAndSplittable(): void
    {
        $files = glob(__DIR__ . '/../../../migrations/*.sql') ?: [];
        self::assertNotEmpty($files);
        foreach ($files as $file) {
            self::assertMatchesRegularExpression('/^\d{4}_[a-z0-9_]+\.sql$/', basename($file));
            self::assertNotEmpty(Migrator::statements((string) file_get_contents($file)));
        }
    }
}
