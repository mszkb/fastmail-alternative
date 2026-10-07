<?php

declare(strict_types=1);

namespace Fma\Tests\Unit\Install;

use Fma\Config;
use Fma\Db\Database;
use Fma\Install\Installer;
use Fma\Install\SystemCheck;
use Fma\Tests\Support\Http;
use PHPUnit\Framework\TestCase;

/** Installer without a reachable database (fresh webspace). */
final class InstallerTest extends TestCase
{
    private const KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';

    /** @param array<string, string> $values */
    private static function installer(array $values): Installer
    {
        $config = Config::fromArray($values + ['DATABASE_URL' => 'mysql://user:db-secret@127.0.0.1:1/mail', 'MAIL_DATA_DIR' => sys_get_temp_dir()]);

        return new Installer($config, new Database($config), __DIR__ . '/../../../migrations', '/srv/fma-app/config.php', new SystemCheck($config, static fn(): bool => true));
    }

    public function testShowsChecksAndConfigSuggestionWithoutSecrets(): void
    {
        $response = self::installer([])->handle(Http::request('GET', '/install.php'));
        $html = (string) $response->getBody();

        self::assertSame(200, $response->getStatusCode());
        self::assertSame('no-store', $response->getHeaderLine('Cache-Control'));
        self::assertStringContainsString('System check', $html);
        self::assertMatchesRegularExpression('/&#039;MASTER_KEY&#039; =&gt; &#039;[A-Za-z0-9+\\/]{43}=&#039;/', $html);
        self::assertStringContainsString('VAPID_PUBLIC_KEY', $html);
        self::assertStringNotContainsString('db-secret', $html);
    }

    public function testNeverEchoesAConfiguredMasterKey(): void
    {
        $html = (string) self::installer(['MASTER_KEY' => self::KEY, 'SETUP_TOKEN' => 'my-setup-token'])->handle(Http::request('GET', '/install.php'))->getBody();

        self::assertStringContainsString('MASTER_KEY is configured', $html);
        self::assertStringNotContainsString(self::KEY, $html);
        self::assertStringNotContainsString('my-setup-token', $html);
    }

    public function testRejectsCrossOriginPost(): void
    {
        $request = Http::request('POST', '/install.php', ['Origin' => 'https://evil.example', 'Content-Type' => 'application/x-www-form-urlencoded'])
            ->withParsedBody(['action' => 'migrate']);

        self::assertSame(403, self::installer([])->handle($request)->getStatusCode());
        $request = Http::request('POST', '/install.php', ['Sec-Fetch-Site' => 'cross-site'])->withParsedBody(['action' => 'migrate']);
        self::assertSame(403, self::installer([])->handle($request)->getStatusCode());
    }

    public function testSetupCodeNeedsTheMasterKey(): void
    {
        $request = Http::request('POST', '/install.php', ['Sec-Fetch-Site' => 'same-origin'])
            ->withParsedBody(['action' => 'setup-code', 'master_key' => 'wrong']);
        $html = (string) self::installer(['MASTER_KEY' => self::KEY])->handle($request)->getBody();

        self::assertStringContainsString('does not match', $html);
        self::assertStringNotContainsString(self::KEY, $html);
    }

    public function testMigrationFailureHidesConnectionDetails(): void
    {
        $request = Http::request('POST', '/install.php', ['Sec-Fetch-Site' => 'same-origin'])->withParsedBody(['action' => 'migrate']);
        $html = (string) self::installer([])->handle($request)->getBody();

        self::assertStringContainsString('Migration failed', $html);
        self::assertStringNotContainsString('db-secret', $html);
        self::assertStringNotContainsString('127.0.0.1', $html);
    }

    public function testFlagsConfigInsideTheWebRoot(): void
    {
        $root = sys_get_temp_dir() . '/fma-root-' . bin2hex(random_bytes(4));
        mkdir($root);
        $config = Config::fromArray(['DATABASE_URL' => 'mysql://u:p@127.0.0.1:1/m', 'MAIL_DATA_DIR' => sys_get_temp_dir()]);
        $installer = new Installer($config, new Database($config), __DIR__, $root . '/config.php', new SystemCheck($config));
        $html = (string) $installer->handle(Http::request('GET', '/install.php', [], ['DOCUMENT_ROOT' => $root]))->getBody();
        rmdir($root);

        self::assertMatchesRegularExpression('#<tr class="fail"><td>FAIL</td><td>config.php outside the web root#', $html);
    }

    public function testGeneratedVapidKeysHaveTheExpectedSize(): void
    {
        $keys = Installer::generateVapidKeys();
        self::assertNotNull($keys);
        self::assertSame(65, \strlen((string) base64_decode(strtr($keys['public'], '-_', '+/'), false)));
        self::assertSame(32, \strlen((string) base64_decode(strtr($keys['private'], '-_', '+/'), false)));
    }
}
