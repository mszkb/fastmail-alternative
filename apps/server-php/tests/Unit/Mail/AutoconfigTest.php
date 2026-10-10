<?php

declare(strict_types=1);

namespace Fma\Tests\Unit\Mail;

use Fma\Mail\Autoconfig;
use Fma\Mail\StreamHttpsGetter;
use Fma\Tests\Support\FakeHttpsGetter as FakeGetter;
use PHPUnit\Framework\TestCase;

/** Settings detection for domains without a preset (#165). */
final class AutoconfigTest extends TestCase
{
    private const XML = <<<'XML'
        <?xml version="1.0" encoding="UTF-8"?>
        <clientConfig version="1.1">
          <emailProvider id="example.org">
            <domain>example.org</domain>
            <incomingServer type="pop3">
              <hostname>pop.example.org</hostname><port>995</port><socketType>SSL</socketType>
            </incomingServer>
            <incomingServer type="imap">
              <hostname>imap.%EMAILDOMAIN%</hostname><port>143</port><socketType>STARTTLS</socketType>
              <username>%EMAILADDRESS%</username>
            </incomingServer>
            <incomingServer type="imap">
              <hostname>IMAP.example.org</hostname><port>993</port><socketType>SSL</socketType>
              <username>%EMAILLOCALPART%</username>
            </incomingServer>
            <outgoingServer type="smtp">
              <hostname>smtp.example.org</hostname><port>25</port><socketType>plain</socketType>
            </outgoingServer>
            <outgoingServer type="smtp">
              <hostname>smtp.example.org</hostname><port>587</port><socketType>STARTTLS</socketType>
            </outgoingServer>
          </emailProvider>
        </clientConfig>
        XML;

    public function testParsePrefersImplicitTlsAndSkipsPlain(): void
    {
        self::assertSame([
            'imap' => ['host' => 'imap.example.org', 'port' => 993],
            'smtp' => ['host' => 'smtp.example.org', 'port' => 587],
            'username' => 'localpart',
        ], Autoconfig::parse(self::XML, 'example.org'));
    }

    public function testParseReplacesDomainPlaceholder(): void
    {
        $xml = '<clientConfig><emailProvider><incomingServer type="imap"><hostname>mail.%EMAILDOMAIN%</hostname>'
            . '<port>993</port><socketType>SSL</socketType><username>%EMAILADDRESS%</username></incomingServer></emailProvider></clientConfig>';
        self::assertSame(
            ['imap' => ['host' => 'mail.example.net', 'port' => 993], 'smtp' => null, 'username' => 'address'],
            Autoconfig::parse($xml, 'example.net'),
        );
    }

    public function testParseRejectsDtdsGarbageAndPlainOnly(): void
    {
        self::assertNull(Autoconfig::parse('', 'example.org'));
        self::assertNull(Autoconfig::parse('<html>not found</html>', 'example.org'));
        self::assertNull(Autoconfig::parse('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><clientConfig/>', 'example.org'));
        $plain = '<clientConfig><emailProvider><incomingServer type="imap"><hostname>imap.example.org</hostname>'
            . '<port>143</port><socketType>plain</socketType></incomingServer></emailProvider></clientConfig>';
        self::assertNull(Autoconfig::parse($plain, 'example.org'));
        $badHost = '<clientConfig><emailProvider><incomingServer type="imap"><hostname>imap example;org</hostname>'
            . '<port>993</port><socketType>SSL</socketType></incomingServer></emailProvider></clientConfig>';
        self::assertNull(Autoconfig::parse($badHost, 'example.org'));
    }

    public function testOrderAutoconfigWellKnownIspdb(): void
    {
        $http = new FakeGetter(['https://example.org/.well-known/autoconfig/mail/config-v1.1.xml' => self::XML]);
        $result = (new Autoconfig($http, true, self::noDns()))->discover('Example.org.');
        self::assertSame('well-known', $result['source'] ?? null);
        self::assertSame([
            'https://autoconfig.example.org/mail/config-v1.1.xml',
            'https://example.org/.well-known/autoconfig/mail/config-v1.1.xml',
        ], $http->requested);

        $http = new FakeGetter([Autoconfig::ISPDB_URL . 'example.org' => self::XML]);
        self::assertSame('ispdb', (new Autoconfig($http, true, self::noDns()))->discover('example.org')['source'] ?? null);
    }

    public function testIspdbCanBeDisabled(): void
    {
        $http = new FakeGetter([Autoconfig::ISPDB_URL . 'example.org' => self::XML, Autoconfig::ISPDB_URL . 'google.com' => self::XML]);
        $dns = static fn(string $name, int $type): array => $type === DNS_MX ? [['target' => 'aspmx.l.google.com', 'pri' => 1]] : [];
        self::assertNull((new Autoconfig($http, false, $dns))->discover('example.org'));
        foreach ($http->requested as $url) {
            self::assertStringNotContainsString('thunderbird', $url);
        }
    }

    public function testSrvRecords(): void
    {
        $dns = static fn(string $name, int $type): array => match ($name) {
            '_imaps._tcp.example.org' => [['target' => '.', 'port' => 0, 'pri' => 0], ['target' => 'imap2.example.org', 'port' => 993, 'pri' => 20], ['target' => 'imap1.example.org.', 'port' => 993, 'pri' => 10]],
            '_submission._tcp.example.org' => [['target' => 'smtp.example.org', 'port' => 587, 'pri' => 0]],
            default => [],
        };
        self::assertSame([
            'source' => 'srv',
            'imap' => ['host' => 'imap1.example.org', 'port' => 993],
            'smtp' => ['host' => 'smtp.example.org', 'port' => 587],
            'username' => 'address',
        ], (new Autoconfig(new FakeGetter([]), true, $dns))->discover('example.org'));
    }

    public function testMxBaseDomainInIspdb(): void
    {
        $http = new FakeGetter([Autoconfig::ISPDB_URL . 'google.com' => self::XML]);
        $dns = static fn(string $name, int $type): array => $type === DNS_MX && $name === 'example.org'
            ? [['target' => 'alt1.aspmx.l.google.com', 'pri' => 5], ['target' => 'aspmx.l.google.com', 'pri' => 1]]
            : [];
        $result = (new Autoconfig($http, true, $dns))->discover('example.org');
        self::assertSame('mx', $result['source'] ?? null);
        self::assertContains(Autoconfig::ISPDB_URL . 'google.com', $http->requested);
    }

    public function testNothingFoundAndInvalidDomain(): void
    {
        $http = new FakeGetter([]);
        self::assertNull((new Autoconfig($http, true, self::noDns()))->discover('example.org'));
        self::assertNull((new Autoconfig($http, true, self::noDns()))->discover('localhost'));
        self::assertNull((new Autoconfig($http, true, self::noDns()))->discover('a/b.example.org'));
        self::assertCount(3, $http->requested);
    }

    public function testBaseDomain(): void
    {
        self::assertSame('google.com', Autoconfig::baseDomain('aspmx.l.google.com'));
        self::assertSame('outlook.com', Autoconfig::baseDomain('example-org.mail.protection.outlook.com'));
        self::assertSame('example.co.uk', Autoconfig::baseDomain('mx.example.co.uk'));
        self::assertSame('example.de', Autoconfig::baseDomain('example.de'));
    }

    public function testHttpsGetterRefusesPrivateTargetsAndOtherSchemes(): void
    {
        $getter = new StreamHttpsGetter(static fn(string $host): array => ['10.0.0.5']);
        self::assertNull($getter->get('https://autoconfig.example.org/mail/config-v1.1.xml', 1.0));
        self::assertNull($getter->get('https://127.0.0.1/x', 1.0));
        self::assertNull($getter->get('http://example.org/x', 1.0));
        self::assertNull($getter->get('https://user:pw@example.org/x', 1.0));
        self::assertNull($getter->get('file:///etc/passwd', 1.0));
    }

    /** @return callable(string, int): list<array<string, mixed>> */
    private static function noDns(): callable
    {
        return static fn(string $name, int $type): array => [];
    }
}
