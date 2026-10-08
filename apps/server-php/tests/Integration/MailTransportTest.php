<?php

declare(strict_types=1);

namespace Fma\Tests\Integration;

use Fma\Config;
use Fma\Log\Logger;
use Fma\Mail\HostConfig;
use Fma\Mail\SocketConnectionTester;
use Fma\Mail\TransportPolicy;
use Fma\Tests\Support\Http;
use PHPUnit\Framework\TestCase;

/**
 * IMAP/SMTP connection tests against GreenMail (GREENMAIL_HOST, plain ports
 * 3143/3025, TLS ports 3993/3465 with a self-signed certificate): STARTTLS
 * is mandatory on
 * plain ports and certificates are verified unless MAIL_INSECURE_TRANSPORT.
 */
final class MailTransportTest extends TestCase
{
    private string $host = '';
    /** @var resource */
    private $log;

    protected function setUp(): void
    {
        $host = getenv('GREENMAIL_HOST');
        if (!\is_string($host) || $host === '') {
            self::markTestSkipped('GREENMAIL_HOST not set');
        }
        $this->host = $host;
        $this->log = Http::memoryStream();
    }

    private function tester(TransportPolicy $policy): SocketConnectionTester
    {
        return new SocketConnectionTester(Config::fromArray([]), new Logger('api', 'info', $this->log), $policy, 5.0);
    }

    private function config(int $port, bool $secure, string $password = 'secret-password'): HostConfig
    {
        return new HostConfig($this->host, $port, $secure, 'transport@example.org', $password);
    }

    public function testInsecureTestModeLogsInOnAllPorts(): void
    {
        $tester = $this->tester(new TransportPolicy(allowPrivateHosts: true, insecureTransport: true));
        $imap = $tester->testImap($this->config(3143, false));
        self::assertTrue($imap->ok);
        self::assertContains('IDLE', $imap->capabilities);
        self::assertTrue($tester->testImap($this->config(3993, true))->ok);
        self::assertTrue($tester->testSmtp($this->config(3025, false))->ok);
        self::assertTrue($tester->testSmtp($this->config(3465, true))->ok);
    }

    public function testRefusesPlainPortsWithoutStartTlsBeforeSendingThePassword(): void
    {
        $tester = $this->tester(new TransportPolicy(allowPrivateHosts: true, extraPorts: [3143, 3025]));
        foreach ([$tester->testImap($this->config(3143, false)), $tester->testSmtp($this->config(3025, false))] as $result) {
            self::assertFalse($result->ok);
            self::assertSame('TLS_REQUIRED', $result->code);
        }
    }

    public function testVerifiesCertificatesOutsideTestMode(): void
    {
        $tester = $this->tester(new TransportPolicy(allowPrivateHosts: true, extraPorts: [3993, 3465]));
        self::assertSame('TLS_ERROR', $tester->testImap($this->config(3993, true))->code);
        self::assertSame('TLS_ERROR', $tester->testSmtp($this->config(3465, true))->code);
    }

    public function testBlocksPrivateHostsAndOtherPorts(): void
    {
        $tester = $this->tester(new TransportPolicy());
        self::assertSame('BLOCKED_HOST', $tester->testImap($this->config(993, true))->code);
        self::assertSame('BLOCKED_PORT', $tester->testImap($this->config(3143, false))->code);
    }

    public function testRefusedConnectionAndNoSecretsInLogs(): void
    {
        $tester = $this->tester(new TransportPolicy(allowPrivateHosts: true, insecureTransport: true));
        self::assertSame('CONNECTION_REFUSED', $tester->testImap($this->config(3999, false))->code);
        $log = Http::contents($this->log);
        self::assertStringContainsString('"code":"CONNECTION_REFUSED"', $log);
        self::assertStringNotContainsString('secret-password', $log);
        self::assertStringNotContainsString('transport@example.org', $log);
    }
}
