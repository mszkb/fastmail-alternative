<?php

declare(strict_types=1);

namespace Fma\Push;

use Fma\Mail\MailException;
use Fma\Mail\Ssrf;

/**
 * HTTP/1.1 POST to a push service on plain PHP streams (port of
 * sendPushRequest in apps/worker/src/jobs/push-notify.ts):
 * - only https to a public host: the host is resolved exactly once, every
 *   address is checked (Fma\Mail\Ssrf) and the socket connects to a
 *   checked address, while TLS still verifies the original hostname (SNI,
 *   peer_name) - no second resolution, so no DNS rebinding;
 * - no redirects (the status is returned as is), a timeout for connect and
 *   response, the response body is discarded (it may echo the endpoint);
 * - `insecure` (MAIL_INSECURE_TRANSPORT=1, dev/test only): http allowed
 *   and plain resolution, so local fake push services work.
 */
final class StreamPushSender implements PushSender
{
    public const TIMEOUT_SECONDS = 15;

    /** @param (callable(string): list<string>)|null $resolve test override for DNS */
    public function __construct(
        private readonly bool $insecure = false,
        private readonly int $timeoutSeconds = self::TIMEOUT_SECONDS,
        private readonly mixed $resolve = null,
    ) {}

    public function send(string $endpoint, array $headers, string $body): int
    {
        $url = Endpoint::parse($endpoint);
        if ($url === null || $url['hasCredentials']) {
            throw new \InvalidArgumentException('invalid push endpoint');
        }
        if (!$this->insecure && $url['scheme'] !== 'https') {
            throw new \InvalidArgumentException('push endpoint is not https');
        }
        $address = $url['host'];
        if (!$this->insecure) {
            $resolve = \is_callable($this->resolve) ? $this->resolve : null;
            // Throws MailException(PRIVATE_HOST_BLOCKED / ENOTFOUND); literal IPs are checked as well.
            $address = Ssrf::assertPublicHost($url['host'], $resolve)[0];
        }
        $isIp = filter_var($url['host'], FILTER_VALIDATE_IP) !== false;
        $context = stream_context_create(['ssl' => [
            'verify_peer' => true,
            'verify_peer_name' => true,
            'allow_self_signed' => false,
            'SNI_enabled' => !$isIp,
            'peer_name' => $url['host'],
            'disable_compression' => true,
        ]]);
        $target = str_contains($address, ':') ? "[{$address}]" : $address;
        $transport = $url['scheme'] === 'https' ? 'tls' : 'tcp';
        $errno = 0;
        $errstr = '';
        $socket = @stream_socket_client("{$transport}://{$target}:{$url['port']}", $errno, $errstr, $this->timeoutSeconds, STREAM_CLIENT_CONNECT, $context);
        if ($socket === false) {
            // errstr may name the address; only the code leaves this method.
            throw new MailException('PUSH_CONNECT_FAILED', 'push service unreachable');
        }
        try {
            stream_set_timeout($socket, $this->timeoutSeconds);
            $deadline = microtime(true) + $this->timeoutSeconds;
            $request = "POST {$url['path']} HTTP/1.1\r\nHost: " . Endpoint::host($endpoint) . "\r\n";
            foreach ($headers + ['Content-Length' => (string) \strlen($body)] as $name => $value) {
                $request .= $name . ': ' . str_replace(["\r", "\n"], '', $value) . "\r\n";
            }
            $request .= "Connection: close\r\n\r\n" . $body;
            for ($written = 0; $written < \strlen($request);) {
                $chunk = @fwrite($socket, substr($request, $written));
                if ($chunk === false || $chunk === 0 || microtime(true) > $deadline) {
                    throw new MailException('PUSH_WRITE_FAILED', 'push request failed');
                }
                $written += $chunk;
            }
            $statusLine = fgets($socket, 1024);
            if (microtime(true) > $deadline || stream_get_meta_data($socket)['timed_out']) {
                throw new MailException('PUSH_TIMEOUT', 'push request timed out');
            }
            if (!\is_string($statusLine) || preg_match('#^HTTP/\d(?:\.\d)? (\d{3})#', $statusLine, $m) !== 1) {
                throw new MailException('PUSH_BAD_RESPONSE', 'invalid push service response');
            }

            return (int) $m[1];
        } finally {
            fclose($socket);
        }
    }
}
