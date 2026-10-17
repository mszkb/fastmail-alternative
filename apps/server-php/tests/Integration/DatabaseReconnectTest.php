<?php

declare(strict_types=1);

namespace Fma\Tests\Integration;

use Fma\Db\Database;

/**
 * The worker survives a database restart (e.g. mariadb-upgrade on the first
 * start of a newer image): a killed connection stays dead until disconnect().
 */
final class DatabaseReconnectTest extends DatabaseTestCase
{
    public function testKilledConnectionWorksAgainOnlyAfterDisconnect(): void
    {
        $db = new Database(self::$config);
        $id = (int) Database::run($db->pdo(), 'SELECT CONNECTION_ID()')->fetchColumn();
        self::$db->pdo()->exec("KILL CONNECTION {$id}");

        for ($attempt = 0; $attempt < 2; ++$attempt) {
            try {
                Database::run($db->pdo(), 'SELECT 1');
                self::fail('expected the killed connection to fail');
            } catch (\PDOException) {
                // Stays broken without disconnect().
            }
        }

        $db->disconnect();
        self::assertSame(1, (int) Database::run($db->pdo(), 'SELECT 1')->fetchColumn());
        self::assertNotSame($id, (int) Database::run($db->pdo(), 'SELECT CONNECTION_ID()')->fetchColumn());
    }
}
