<?php

declare(strict_types=1);

namespace Fma\Tests\Integration;

use Fma\Auth\SetupCode;
use Fma\Config;
use Fma\Db\Database;
use Fma\Db\Uuid;
use Fma\Install\Installer;
use Fma\Install\SystemCheck;
use Fma\Log\Logger;
use Fma\Tests\Support\Http;

final class InstallerTest extends DatabaseTestCase
{
    private const KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';

    private static function installer(Config $config): Installer
    {
        return new Installer($config, new Database($config), __DIR__ . '/../../migrations', '/srv/fma-app/config.php', new SystemCheck($config, static fn(): bool => true));
    }

    private static function config(): Config
    {
        return Config::fromArray(['DATABASE_URL' => (string) self::$config->get('DATABASE_URL'), 'MASTER_KEY' => self::KEY, 'MAIL_DATA_DIR' => sys_get_temp_dir()]);
    }

    public function testMigratesHandsOutASetupCodeAndDisablesItselfOnceAUserExists(): void
    {
        $config = self::config();
        $post = static fn(array $body) => Http::request('POST', '/install.php', ['Sec-Fetch-Site' => 'same-origin'])->withParsedBody($body);

        $html = (string) self::installer($config)->handle($post(['action' => 'migrate']))->getBody();
        self::assertStringContainsString('0 migration(s) applied.', $html);

        $html = (string) self::installer($config)->handle($post(['action' => 'setup-code', 'master_key' => ' ' . self::KEY . ' ']))->getBody();
        self::assertSame(1, preg_match('#<code class="big">([A-Z2-7-]{29})</code>#', $html, $m));
        self::assertTrue((new SetupCode($config, new Database($config), new Logger('test')))->matches($m[1] ?? ''));

        Database::run(self::$db->pdo(), 'INSERT INTO `user` (id, email, password_hash) VALUES (?, ?, ?)', [Uuid::v4(), 'owner@example.org', 'unused']);
        self::assertSame(404, self::installer($config)->handle(Http::request('GET', '/install.php'))->getStatusCode());
        self::assertSame(404, self::installer($config)->handle($post(['action' => 'setup-code', 'master_key' => self::KEY]))->getStatusCode());
    }
}
