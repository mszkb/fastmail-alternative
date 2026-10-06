<?php

declare(strict_types=1);

namespace Fma\Tests\Unit\Log;

use Fma\Log\Logger;
use Fma\Tests\Support\Http;
use PHPUnit\Framework\TestCase;

final class LoggerTest extends TestCase
{
    public function testRedactsSensitiveKeysAtAnyDepth(): void
    {
        $stream = Http::memoryStream();
        (new Logger('api', 'info', $stream))->info('x', [
            'password' => 'hunter2',
            'account' => ['id' => 'a1', 'Subject' => 'Geheim', 'nested' => ['authorization' => 'Bearer t']],
            'count' => 3,
        ]);
        $entry = json_decode(Http::contents($stream), true);
        self::assertIsArray($entry);
        self::assertSame('[REDACTED]', $entry['password']);
        self::assertSame(['id' => 'a1', 'Subject' => '[REDACTED]', 'nested' => ['authorization' => '[REDACTED]']], $entry['account']);
        self::assertSame(3, $entry['count']);
        self::assertSame(30, $entry['level']);
        self::assertSame('api', $entry['service']);
        self::assertSame('x', $entry['msg']);
    }

    public function testRespectsLevel(): void
    {
        $stream = Http::memoryStream();
        $logger = new Logger('api', 'warn', $stream);
        $logger->info('hidden');
        $logger->warn('shown');
        self::assertSame(1, substr_count(Http::contents($stream), "\n"));
    }
}
