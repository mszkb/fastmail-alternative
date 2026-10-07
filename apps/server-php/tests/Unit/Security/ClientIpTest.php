<?php

declare(strict_types=1);

namespace Fma\Tests\Unit\Security;

use Fma\Security\ClientIp;
use Fma\Tests\Support\Http;
use PHPUnit\Framework\TestCase;

final class ClientIpTest extends TestCase
{
    public function testPublicPeerIgnoresForwardedFor(): void
    {
        $request = Http::request('GET', '/', ['X-Forwarded-For' => '1.2.3.4'], ['REMOTE_ADDR' => '203.0.113.9']);
        self::assertSame('203.0.113.9', ClientIp::fromRequest($request));
    }

    public function testPrivateProxyUsesRightMostEntry(): void
    {
        $request = Http::request('GET', '/', ['X-Forwarded-For' => '6.6.6.6, 198.51.100.4'], ['REMOTE_ADDR' => '172.18.0.5']);
        self::assertSame('198.51.100.4', ClientIp::fromRequest($request));
    }

    public function testInvalidForwardedForFallsBackToPeer(): void
    {
        $request = Http::request('GET', '/', ['X-Forwarded-For' => 'garbage'], ['REMOTE_ADDR' => '127.0.0.1']);
        self::assertSame('127.0.0.1', ClientIp::fromRequest($request));
    }

    public function testPrivateRanges(): void
    {
        foreach (['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '::1', 'fd00::1', '::ffff:10.0.0.1'] as $ip) {
            self::assertTrue(ClientIp::isPrivate($ip), $ip);
        }
        foreach (['8.8.8.8', '172.32.0.1', '2001:db8::1', '::ffff:8.8.8.8', 'nonsense'] as $ip) {
            self::assertFalse(ClientIp::isPrivate($ip), $ip);
        }
    }
}
