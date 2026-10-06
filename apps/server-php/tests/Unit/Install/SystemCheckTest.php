<?php

declare(strict_types=1);

namespace Fma\Tests\Unit\Install;

use Fma\Config;
use Fma\Install\SystemCheck;
use PHPUnit\Framework\TestCase;

final class SystemCheckTest extends TestCase
{
    public function testReportsMissingKeyAndDatabaseWithoutLeakingSecrets(): void
    {
        $dir = sys_get_temp_dir() . '/fma-check-' . bin2hex(random_bytes(4));
        $config = Config::fromArray([
            'MASTER_KEY' => 'too-short',
            'DATABASE_URL' => 'mysql://user:very-secret@127.0.0.1:1/mail',
            'MAIL_DATA_DIR' => $dir,
        ]);
        $probed = [];
        $checks = (new SystemCheck($config, static function (string $host, int $port) use (&$probed): bool {
            $probed[] = "{$host}:{$port}";

            return $port !== 587;
        }))->run();
        $byName = array_column($checks, null, 'name');

        self::assertFalse($byName['MASTER_KEY']['ok']);
        self::assertFalse($byName['Database (MySQL >= 8.0.1 / MariaDB >= 10.6)']['ok']);
        self::assertTrue($byName['MAIL_DATA_DIR writable']['ok']);
        self::assertFalse($byName['Outbound smtp.gmail.com:587']['ok']);
        self::assertFalse($byName['Outbound smtp.gmail.com:587']['required']);
        self::assertCount(3, $probed);
        self::assertFalse(SystemCheck::passed($checks));
        self::assertStringNotContainsString('very-secret', (string) json_encode($checks));
        self::assertStringNotContainsString('too-short', (string) json_encode($checks));
        rmdir($dir);
    }

    public function testGeneratedMasterKeyIsValid(): void
    {
        self::assertSame(32, \strlen((string) base64_decode(SystemCheck::generateMasterKey(), true)));
    }
}
