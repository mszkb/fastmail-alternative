<?php

declare(strict_types=1);

namespace Fma\Mail;

/**
 * HTTPS GET on plain PHP streams, with the same SSRF protection as the push
 * sender (Fma\Push\StreamPushSender):
 * - only https to a public host: resolved once, every address checked
 *   (Ssrf), the socket connects to a checked address while TLS verifies
 *   the original hostname - no DNS rebinding;
 * - HTTP/1.0 without Accept-Encoding, so the body is neither chunked nor
 *   compressed; at most MAX_BYTES are read;
 * - up to MAX_REDIRECTS redirects, each to https and checked again.
 */
final class StreamHttpsGetter implements HttpsGetter
{
    public const MAX_BYTES = 256 * 1024;
    public const MAX_REDIRECTS = 2;
    private const URL_RE = '#^https://([a-z0-9.-]+)(?::(\d{1,5}))?(/[^\s]*)?\z#i';

    /** @param (callable(string): list<string>)|null $resolve test override for DNS */
    public function __construct(private readonly mixed $resolve = null) {}

    public function get(string $url, float $timeoutSeconds): ?string
    {
        $deadline = microtime(true) + $timeoutSeconds;
        for ($hop = 0; $hop <= self::MAX_REDIRECTS; ++$hop) {
            $result = $this->request($url, $deadline);
            if ($result === null) {
                return null;
            }
            [$status, $location, $body] = $result;
            if ($status === 200) {
                return $body;
            }
            if (!\in_array($status, [301, 302, 303, 307, 308], true) || $location === null) {
                return null;
            }
            $url = $location;
        }

        return null;
    }

    /** @return array{int, ?string, string}|null status, redirect target, body */
    private function request(string $url, float $deadline): ?array
    {
        if (preg_match(self::URL_RE, $url, $m) !== 1) {
            return null;
        }
        $host = strtolower($m[1]);
        $port = ($m[2] ?? '') !== '' ? (int) $m[2] : 443;
        $path = ($m[3] ?? '') !== '' ? $m[3] : '/';
        if ($port < 1 || $port > 65535) {
            return null;
        }
        try {
            $resolve = \is_callable($this->resolve) ? $this->resolve : null;
            $address = Ssrf::assertPublicHost($host, $resolve)[0];
        } catch (MailException) {
            return null;
        }
        $remaining = $deadline - microtime(true);
        if ($remaining <= 0) {
            return null;
        }
        $context = stream_context_create(['ssl' => [
            'verify_peer' => true,
            'verify_peer_name' => true,
            'allow_self_signed' => false,
            'SNI_enabled' => filter_var($host, FILTER_VALIDATE_IP) === false,
            'peer_name' => $host,
            'disable_compression' => true,
        ]]);
        $target = str_contains($address, ':') ? "[{$address}]" : $address;
        $socket = @stream_socket_client("tls://{$target}:{$port}", $errno, $errstr, $remaining, STREAM_CLIENT_CONNECT, $context);
        if ($socket === false) {
            return null;
        }
        try {
            stream_set_timeout($socket, max(1, (int) ceil($deadline - microtime(true))));
            $hostHeader = $port === 443 ? $host : "{$host}:{$port}";
            $request = "GET {$path} HTTP/1.0\r\nHost: {$hostHeader}\r\nUser-Agent: fastmail-alternative-autoconfig\r\nAccept: application/xml, text/xml\r\nConnection: close\r\n\r\n";
            if (@fwrite($socket, $request) !== \strlen($request)) {
                return null;
            }
            $raw = '';
            while (!feof($socket) && \strlen($raw) <= self::MAX_BYTES + 8192) {
                $chunk = fread($socket, 8192);
                if ($chunk === false || microtime(true) > $deadline || stream_get_meta_data($socket)['timed_out']) {
                    return null;
                }
                $raw .= $chunk;
            }
        } finally {
            fclose($socket);
        }
        $split = strpos($raw, "\r\n\r\n");
        if ($split === false || preg_match('#^HTTP/\d(?:\.\d)? (\d{3})#', $raw, $status) !== 1) {
            return null;
        }
        $body = substr($raw, $split + 4);
        if (\strlen($body) > self::MAX_BYTES) {
            return null;
        }
        $location = null;
        if (preg_match('#^Location:[ \t]*(\S+)[ \t]*$#mi', substr($raw, 0, $split), $loc) === 1) {
            $location = str_starts_with($loc[1], '/') ? 'https://' . $hostHeader . $loc[1] : $loc[1];
        }

        return [(int) $status[1], $location, $body];
    }
}
