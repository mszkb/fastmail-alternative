<?php

declare(strict_types=1);

namespace Fma\Tests\Unit;

use Fma\Config;
use Fma\Db\Database;
use PHPUnit\Framework\TestCase;

final class ConfigTest extends TestCase
{
    public function testEnvironmentWinsOverConfigFile(): void
    {
        $file = tempnam(sys_get_temp_dir(), 'fma');
        file_put_contents($file, "<?php return ['MASTER_KEY' => 'from-file', 'LOG_LEVEL' => 'debug', 'METRICS_TOKEN' => 'f'];");
        $config = Config::load(['MASTER_KEY' => 'from-env', 'METRICS_TOKEN' => ''], $file);
        unlink($file);
        self::assertSame('from-env', $config->get('MASTER_KEY'));
        self::assertSame('debug', $config->get('LOG_LEVEL'));
        // An empty environment variable does not override the file.
        self::assertSame('f', $config->get('METRICS_TOKEN'));
    }

    public function testServerVariablesCountButRequestHeadersDoNot(): void
    {
        $backup = $_SERVER;
        $_SERVER['FMA_TEST_SETENV'] = 'from-setenv';
        $_SERVER['HTTP_MASTER_KEY'] = 'injected';
        try {
            $config = Config::load(file: '/nonexistent/config.php');
            self::assertSame('from-setenv', $config->get('FMA_TEST_SETENV'));
            self::assertSame('', $config->get('HTTP_MASTER_KEY'));
        } finally {
            $_SERVER = $backup;
        }
    }

    public function testMissingFileIsFine(): void
    {
        self::assertSame('x', Config::load([], '/nonexistent/config.php')->get('A', 'x'));
    }

    public function testIntFallsBackOnInvalidOrZero(): void
    {
        $config = Config::fromArray(['A' => '0', 'B' => 'abc', 'C' => '42']);
        self::assertSame(7, $config->int('A', 7));
        self::assertSame(7, $config->int('B', 7));
        self::assertSame(42, $config->int('C', 7));
    }

    public function testDatabaseUrl(): void
    {
        [$dsn, $user, $password] = Database::dsn(Config::fromArray(['DATABASE_URL' => 'mysql://mail:p%40ss@db:3307/mail']));
        self::assertSame('mysql:host=db;port=3307;dbname=mail;charset=utf8mb4', $dsn);
        self::assertSame('mail', $user);
        self::assertSame('p@ss', $password);
    }

    public function testDatabaseVariables(): void
    {
        [$dsn, $user] = Database::dsn(Config::fromArray(['DB_HOST' => 'localhost', 'DB_NAME' => 'fma', 'DB_USER' => 'u']));
        self::assertSame('mysql:host=localhost;port=3306;dbname=fma;charset=utf8mb4', $dsn);
        self::assertSame('u', $user);
    }

    public function testRejectsNonMysqlUrl(): void
    {
        $this->expectException(\RuntimeException::class);
        Database::dsn(Config::fromArray(['DATABASE_URL' => 'postgres://a@b/c']));
    }
}
