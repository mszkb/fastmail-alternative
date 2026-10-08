<?php

declare(strict_types=1);

namespace Fma\Mail;

use Fma\Config;
use Fma\Log\Logger;

/**
 * IMAP/SMTP connection test:
 * connect, TLS, login; the result carries a stable code and a fixed German
 * message, never a server text. Only stage and code are logged.
 */
final class SocketConnectionTester implements ConnectionTester
{
    private const MESSAGES = [
        'BLOCKED_PORT' => 'Port nicht erlaubt (IMAP 143/993, SMTP 25/465/587/2525).',
        'TLS_REQUIRED' => 'Der Server bietet keine verschlüsselte Verbindung (STARTTLS) an – das Passwort wurde nicht gesendet. Einen TLS-Port (IMAP 993, SMTP 465) verwenden oder den Anbieter prüfen.',
        'AUTH_FAILED' => 'Zugangsdaten wurden abgelehnt.',
        'HOST_NOT_FOUND' => 'Host nicht gefunden - bitte Namen prüfen.',
        'CONNECTION_REFUSED' => 'Verbindung abgelehnt - Host/Port prüfen.',
        'TIMEOUT' => 'Zeitüberschreitung beim Verbinden.',
        'TLS_ERROR' => 'TLS-Fehler - Zertifikat des Servers konnte nicht verifiziert werden.',
        'BLOCKED_HOST' => 'Interner Host ist blockiert (SSRF-Schutz).',
        'UNKNOWN' => 'Verbindung fehlgeschlagen.',
    ];
    private const CODES = [
        'PORT_NOT_ALLOWED' => 'BLOCKED_PORT',
        'TLS_REQUIRED' => 'TLS_REQUIRED',
        'AUTH_FAILED' => 'AUTH_FAILED',
        'ENOTFOUND' => 'HOST_NOT_FOUND',
        'ECONNREFUSED' => 'CONNECTION_REFUSED',
        'ETIMEDOUT' => 'TIMEOUT',
        'ETLS' => 'TLS_ERROR',
        'PRIVATE_HOST_BLOCKED' => 'BLOCKED_HOST',
    ];

    private readonly TransportPolicy $policy;

    public function __construct(Config $config, private readonly Logger $logger, ?TransportPolicy $policy = null, private readonly float $timeout = 15.0)
    {
        $this->policy = $policy ?? TransportPolicy::fromConfig($config);
    }

    public function testImap(HostConfig $config): TestResult
    {
        try {
            $client = ImapClient::connect($this->policy, $config, $this->timeout);
            $capabilities = $client->capabilities();
            $client->logout();

            return new TestResult(true, capabilities: $capabilities);
        } catch (MailException $e) {
            return $this->failure('imap', $e);
        }
    }

    public function testSmtp(HostConfig $config): TestResult
    {
        try {
            SmtpClient::connect($this->policy, $config, $this->timeout)->quit();

            return new TestResult(true);
        } catch (MailException $e) {
            return $this->failure('smtp', $e);
        }
    }

    private function failure(string $stage, MailException $e): TestResult
    {
        $code = self::CODES[$e->errorCode] ?? 'UNKNOWN';
        $this->logger->warn('connection test failed', ['stage' => $stage, 'code' => $code, 'errCode' => $e->errorCode]);

        return new TestResult(false, $code, self::MESSAGES[$code]);
    }
}
