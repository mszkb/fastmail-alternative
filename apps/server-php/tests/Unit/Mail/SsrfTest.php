<?php

declare(strict_types=1);

namespace Fma\Tests\Unit\Mail;

use Fma\Mail\MailException;
use Fma\Mail\Ssrf;
use Fma\Mail\TransportPolicy;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/** SSRF host checks and the port policy. */
final class SsrfTest extends TestCase
{
    /** @return iterable<string, array{string}> */
    public static function blocked(): iterable
    {
        yield 'loopback: 127.0.0.1' => ['127.0.0.1'];
        yield 'loopback range: 127.8.8.8' => ['127.8.8.8'];
        yield 'private: 10.0.0.1' => ['10.0.0.1'];
        yield 'private: 10.255.255.255' => ['10.255.255.255'];
        yield 'private: 172.16.0.1' => ['172.16.0.1'];
        yield 'private: 172.31.255.255' => ['172.31.255.255'];
        yield 'private: 192.168.1.1' => ['192.168.1.1'];
        yield 'link-local: 169.254.1.1' => ['169.254.1.1'];
        yield 'this-network: 0.0.0.0' => ['0.0.0.0'];
        yield 'CGNAT: 100.64.0.1' => ['100.64.0.1'];
        yield 'multicast: 224.0.0.1' => ['224.0.0.1'];
        yield 'broadcast: 255.255.255.255' => ['255.255.255.255'];
        yield 'TEST-NET-2: 198.51.100.1' => ['198.51.100.1'];
        yield 'TEST-NET-3: 203.0.113.1' => ['203.0.113.1'];
        yield 'loopback: ::1' => ['::1'];
        yield 'unspecified: ::' => ['::'];
        yield 'link-local: fe80::1' => ['fe80::1'];
        yield 'unique-local: fd00::1' => ['fd00::1'];
        yield 'unique-local: fc00::1' => ['fc00::1'];
        yield 'multicast: ff02::1' => ['ff02::1'];
        yield 'ipv4-mapped loopback: ::ffff:127.0.0.1' => ['::ffff:127.0.0.1'];
        yield 'ipv4-mapped private: ::ffff:10.0.0.1' => ['::ffff:10.0.0.1'];
        yield 'documentation: 2001:db8::1' => ['2001:db8::1'];
        yield '6to4 of 10.0.0.1: 2002:a00:1::1' => ['2002:a00:1::1'];
        yield '6to4 of 127.0.0.1: 2002:7f00:1::' => ['2002:7f00:1::'];
        yield '6to4 of 192.168.1.1: 2002:c0a8:101::1' => ['2002:c0a8:101::1'];
        yield '6to4 of 169.254.169.254: 2002:a9fe:a9fe::1' => ['2002:a9fe:a9fe::1'];
        yield '6to4 of 0.0.0.0: 2002::1' => ['2002::1'];
        yield 'v4-mapped loopback, long form: 0:0:0:0:0:ffff:127.0.0.1' => ['0:0:0:0:0:ffff:127.0.0.1'];
        yield 'v4-mapped private, partly compressed: 0::ffff:10.0.0.1' => ['0::ffff:10.0.0.1'];
        yield 'v4-mapped 10.0.0.1, hex: ::0:ffff:a00:1' => ['::0:ffff:a00:1'];
        yield 'v4-mapped 172.18.0.2, hex long form: 0:0:0:0:0:ffff:ac12:2' => ['0:0:0:0:0:ffff:ac12:2'];
        yield 'v4-mapped loopback, upper case: ::FFFF:7F00:1' => ['::FFFF:7F00:1'];
        yield 'v4-mapped 192.168.1.1, zero padded: 0000:0000:0000:0000:0000:ffff:c0a8:0101' => ['0000:0000:0000:0000:0000:ffff:c0a8:0101'];
        yield 'IPv4-translated loopback: ::ffff:0:127.0.0.1' => ['::ffff:0:127.0.0.1'];
        yield 'IPv4-compatible loopback: ::127.0.0.1' => ['::127.0.0.1'];
        yield 'IPv4-compatible 169.254.169.254: ::a9fe:a9fe' => ['::a9fe:a9fe'];
        yield 'loopback, long form: 0:0:0:0:0:0:0:1' => ['0:0:0:0:0:0:0:1'];
        yield 'unspecified, long form: 0:0:0:0:0:0:0:0' => ['0:0:0:0:0:0:0:0'];
        yield 'NAT64 of private: 64:ff9b::10.0.0.1' => ['64:ff9b::10.0.0.1'];
        yield 'NAT64 of loopback, hex: 64:ff9b::7f00:1' => ['64:ff9b::7f00:1'];
        yield 'local-use NAT64: 64:ff9b:1::8.8.8.8' => ['64:ff9b:1::8.8.8.8'];
        yield '6to4 of 10.0.0.1, zero padded: 2002:0a00:0001::' => ['2002:0a00:0001::'];
        yield 'Teredo: 2001:0:4136:e378::1' => ['2001:0:4136:e378::1'];
        yield 'link-local, upper case: FE80:0:0:0::1' => ['FE80:0:0:0::1'];
        yield 'link-local with zone id: fe80::1%eth0' => ['fe80::1%eth0'];
        yield 'documentation 3fff::/20: 3fff::1' => ['3fff::1'];
        yield 'reserved ::/64 remainder: 0:0:0:0:1::1' => ['0:0:0:0:1::1'];
        yield 'malformed/other: 999.1.1.1' => ['999.1.1.1'];
        yield 'malformed/other: not-an-ip' => ['not-an-ip'];
        yield 'malformed/other: 3fff:fff::1' => ['3fff:fff::1'];
    }

    /** @return iterable<string, array{string}> */
    public static function public(): iterable
    {
        yield '93.184.216.34' => ['93.184.216.34'];
        yield '8.8.8.8' => ['8.8.8.8'];
        yield '1.1.1.1' => ['1.1.1.1'];
        yield '172.32.0.1' => ['172.32.0.1'];
        yield '192.169.1.1' => ['192.169.1.1'];
        yield '11.0.0.1' => ['11.0.0.1'];
        yield '2606:4700::1111' => ['2606:4700::1111'];
        yield '2a01:4f8::1' => ['2a01:4f8::1'];
        yield '::ffff:8.8.8.8' => ['::ffff:8.8.8.8'];
        yield '0:0:0:0:0:ffff:8.8.8.8' => ['0:0:0:0:0:ffff:8.8.8.8'];
        yield '::ffff:808:808' => ['::ffff:808:808'];
        yield '64:ff9b::8.8.8.8' => ['64:ff9b::8.8.8.8'];
        yield '2002:808:808::1' => ['2002:808:808::1'];
        yield '2002:5db8:d822::1' => ['2002:5db8:d822::1'];
        yield '3fff:1000::1' => ['3fff:1000::1'];
        yield '3ff0::1' => ['3ff0::1'];
    }

    #[DataProvider('blocked')]
    public function testBlocks(string $address): void
    {
        self::assertFalse(Ssrf::isPublicIp($address));
    }

    #[DataProvider('public')]
    public function testAllows(string $address): void
    {
        self::assertTrue(Ssrf::isPublicIp($address));
    }

    public function testBlocksWhenAnyResolvedAddressIsPrivate(): void
    {
        self::assertErrorCode('PRIVATE_HOST_BLOCKED', static fn() => Ssrf::assertPublicHost('evil.example', static fn(): array => ['93.184.216.34', '192.168.0.10']));
    }

    public function testPassesForPublicResolutions(): void
    {
        self::assertSame(['93.184.216.34'], Ssrf::assertPublicHost('mail.example.com', static fn(): array => ['93.184.216.34']));
    }

    public function testRejectsUnresolvableHosts(): void
    {
        $this->expectException(MailException::class);
        Ssrf::assertPublicHost('unresolvable.example', static fn(): array => []);
    }

    public function testValidatesLiteralIpsWithoutDns(): void
    {
        $noDns = static function (): array {
            throw new \LogicException('no DNS for literals');
        };
        self::assertSame(['8.8.8.8'], Ssrf::assertPublicHost('8.8.8.8', $noDns));
        $this->expectException(MailException::class);
        Ssrf::assertPublicHost('127.0.0.1', $noDns);
    }

    public function testPortAllowlist(): void
    {
        $policy = new TransportPolicy(extraPorts: [1143]);
        foreach ([143, 993, 1143] as $port) {
            self::assertTrue($policy->isAllowedPort('imap', $port), (string) $port);
        }
        foreach ([25, 465, 587, 2525] as $port) {
            self::assertTrue($policy->isAllowedPort('smtp', $port), (string) $port);
            self::assertFalse($policy->isAllowedPort('imap', $port), (string) $port);
        }
        self::assertFalse($policy->isAllowedPort('smtp', 22));
        self::assertTrue((new TransportPolicy(insecureTransport: true))->isAllowedPort('smtp', 22));
    }

    public function testResolvesOnceAndConnectsToTheCheckedAddressWithSni(): void
    {
        $calls = 0;
        $policy = new TransportPolicy(resolve: static function () use (&$calls): array {
            ++$calls;

            return ['2606:4700::1111', '93.184.216.34'];
        });
        self::assertSame(['address' => '93.184.216.34', 'servername' => 'imap.example.com'], $policy->resolveTarget('imap', 'imap.example.com', 993));
        self::assertSame(1, $calls);
    }

    public function testPrivateHostsOnlyWithTheSwitch(): void
    {
        self::assertSame(['address' => 'mail.lan', 'servername' => 'mail.lan'], (new TransportPolicy(allowPrivateHosts: true))->resolveTarget('imap', 'mail.lan', 993));
        // MAIL_INSECURE_TRANSPORT alone does not switch off the SSRF check.
        self::assertErrorCode('PRIVATE_HOST_BLOCKED', static fn() => (new TransportPolicy(insecureTransport: true, resolve: static fn(): array => ['10.0.0.5']))->resolveTarget('imap', 'mail.lan', 993));
        self::assertErrorCode('PORT_NOT_ALLOWED', static fn() => (new TransportPolicy(allowPrivateHosts: true))->resolveTarget('imap', 'mail.lan', 25));
    }

    private static function assertErrorCode(string $code, callable $fn): void
    {
        try {
            $fn();
            self::fail("expected {$code}");
        } catch (MailException $e) {
            self::assertSame($code, $e->errorCode);
        }
    }
}
