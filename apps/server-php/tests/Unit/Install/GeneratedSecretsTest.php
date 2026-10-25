<?php

declare(strict_types=1);

namespace Fma\Tests\Unit\Install;

use Fma\Config;
use Fma\Install\GeneratedSecrets;
use PHPUnit\Framework\TestCase;

/** Secrets generated on the first docker start (#164). */
final class GeneratedSecretsTest extends TestCase
{
    private string $dir;

    protected function setUp(): void
    {
        $this->dir = sys_get_temp_dir() . '/fma-secrets-' . bin2hex(random_bytes(4));
    }

    protected function tearDown(): void
    {
        foreach (glob($this->dir . '/*') ?: [] as $file) {
            chmod($file, 0o600);
            unlink($file);
        }
        if (is_dir($this->dir)) {
            rmdir($this->dir);
        }
    }

    public function testGeneratesWhatIsMissingOnceWithTightPermissions(): void
    {
        $generated = GeneratedSecrets::ensure($this->dir, []);
        self::assertSame(['MASTER_KEY', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'DB_PASSWORD'], $generated);
        $file = $this->dir . '/' . GeneratedSecrets::FILE;
        $values = GeneratedSecrets::load($file);
        self::assertSame(32, \strlen((string) base64_decode($values['MASTER_KEY'], true)));
        self::assertMatchesRegularExpression('/^[A-Za-z0-9_-]{87}$/', $values['VAPID_PUBLIC_KEY']);
        self::assertMatchesRegularExpression('/^[A-Za-z0-9_-]{43}$/', $values['VAPID_PRIVATE_KEY']);
        self::assertSame(0o600, fileperms($file) & 0o777);
        self::assertSame(0o700, fileperms($this->dir) & 0o777);
        $mariadb = $this->dir . '/' . GeneratedSecrets::MARIADB_FILE;
        self::assertSame($values['DB_PASSWORD'], file_get_contents($mariadb));
        self::assertSame(0o400, fileperms($mariadb) & 0o777);

        // Second start: nothing new, nothing replaced.
        self::assertSame([], GeneratedSecrets::ensure($this->dir, []));
        self::assertSame($values, GeneratedSecrets::load($file));
    }

    public function testValuesFromTheEnvironmentAreNeverWritten(): void
    {
        $env = ['MASTER_KEY' => base64_encode(random_bytes(32)), 'MARIADB_PASSWORD' => 'from-env', 'VAPID_PUBLIC_KEY' => 'pub-only'];
        self::assertSame([], GeneratedSecrets::ensure($this->dir, $env));
        self::assertFileDoesNotExist($this->dir . '/' . GeneratedSecrets::FILE);
        // MariaDB gets the .env password, also after it changed.
        self::assertSame('from-env', file_get_contents($this->dir . '/' . GeneratedSecrets::MARIADB_FILE));
        GeneratedSecrets::ensure($this->dir, ['MARIADB_PASSWORD' => 'changed'] + $env);
        self::assertSame('changed', file_get_contents($this->dir . '/' . GeneratedSecrets::MARIADB_FILE));
    }

    public function testConfigReadsTheFileWithTheLowestPriority(): void
    {
        GeneratedSecrets::ensure($this->dir, []);
        $file = $this->dir . '/' . GeneratedSecrets::FILE;
        $stored = GeneratedSecrets::load($file);

        $config = Config::load(['SECRETS_FILE' => $file, 'DB_PASSWORD' => ''], '/nonexistent/config.php');
        self::assertSame($stored['MASTER_KEY'], $config->get('MASTER_KEY'));
        self::assertSame($stored['DB_PASSWORD'], $config->get('DB_PASSWORD'));
        self::assertTrue($config->isGenerated('MASTER_KEY'));

        $config = Config::load(['SECRETS_FILE' => $file, 'MASTER_KEY' => 'from-env'], '/nonexistent/config.php');
        self::assertSame('from-env', $config->get('MASTER_KEY'));
        self::assertFalse($config->isGenerated('MASTER_KEY'));
        self::assertTrue($config->isGenerated('VAPID_PUBLIC_KEY'));

        $php = tempnam(sys_get_temp_dir(), 'fma');
        file_put_contents($php, "<?php return ['MASTER_KEY' => 'from-config-php'];");
        $config = Config::load(['SECRETS_FILE' => $file], $php);
        unlink($php);
        self::assertSame('from-config-php', $config->get('MASTER_KEY'));
        self::assertFalse($config->isGenerated('MASTER_KEY'));
    }

    public function testLoadIgnoresUnknownNamesAndMissingFiles(): void
    {
        mkdir($this->dir, 0o700);
        $file = $this->dir . '/' . GeneratedSecrets::FILE;
        file_put_contents($file, json_encode(['MASTER_KEY' => 'k', 'DATABASE_URL' => 'mysql://evil', 'DB_PASSWORD' => 1]));
        self::assertSame(['MASTER_KEY' => 'k'], GeneratedSecrets::load($file));
        self::assertSame([], GeneratedSecrets::load($this->dir . '/missing.json'));
        self::assertSame([], GeneratedSecrets::load(''));
    }
}
