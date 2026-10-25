<?php

declare(strict_types=1);

namespace Fma\Push;

use Fma\Mail\MailException;

/**
 * HttpClient on PHP's https stream wrapper (no ext-curl needed on shared
 * hosting): TLS verified, no redirects, timeout. Only used for the fixed
 * Google hosts (oauth2.googleapis.com, fcm.googleapis.com), never for
 * user-supplied URLs - those go through StreamPushSender (SSRF-pinned).
 */
final class StreamHttpClient implements HttpClient
{
    public const TIMEOUT_SECONDS = 15;
    private const MAX_RESPONSE_BYTES = 65536;

    public function __construct(private readonly int $timeoutSeconds = self::TIMEOUT_SECONDS) {}

    public function post(string $url, array $headers, string $body): array
    {
        $lines = [];
        foreach ($headers + ['Content-Length' => (string) \strlen($body)] as $name => $value) {
            $lines[] = $name . ': ' . str_replace(["\r", "\n"], '', $value);
        }
        $context = stream_context_create([
            'http' => [
                'method' => 'POST',
                'header' => implode("\r\n", $lines),
                'content' => $body,
                'timeout' => $this->timeoutSeconds,
                'follow_location' => 0,
                'max_redirects' => 0,
                'ignore_errors' => true,
                'protocol_version' => 1.1,
            ],
            'ssl' => ['verify_peer' => true, 'verify_peer_name' => true],
        ]);
        $stream = @fopen($url, 'r', false, $context);
        if ($stream === false) {
            throw new MailException('PUSH_CONNECT_FAILED', 'push service unreachable');
        }
        try {
            $meta = stream_get_meta_data($stream);
            $response = stream_get_contents($stream, self::MAX_RESPONSE_BYTES);
            $status = 0;
            $wrapperData = $meta['wrapper_data'] ?? [];
            foreach (\is_array($wrapperData) ? $wrapperData : [] as $line) {
                // The last status line wins (there are no redirects, but 100-continue may precede it).
                if (\is_string($line) && preg_match('#^HTTP/\d(?:\.\d)? (\d{3})#', $line, $m) === 1) {
                    $status = (int) $m[1];
                }
            }
            if ($status === 0) {
                throw new MailException('PUSH_BAD_RESPONSE', 'invalid push service response');
            }

            return ['status' => $status, 'body' => \is_string($response) ? $response : ''];
        } finally {
            fclose($stream);
        }
    }
}
