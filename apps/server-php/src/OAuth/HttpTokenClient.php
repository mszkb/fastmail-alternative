<?php

declare(strict_types=1);

namespace Fma\OAuth;

/**
 * Token endpoint client over PHP streams: HTTPS only (certificate checked),
 * no redirects, short timeout. The endpoints are fixed per provider
 * (Provider), never user input.
 */
final class HttpTokenClient implements TokenClient
{
    public function __construct(private readonly float $timeout = 15.0) {}

    public function post(string $url, #[\SensitiveParameter] array $form): array
    {
        if (!str_starts_with($url, 'https://')) {
            throw new OAuthException('network');
        }
        $context = stream_context_create([
            'http' => [
                'method' => 'POST',
                'header' => "Content-Type: application/x-www-form-urlencoded\r\nAccept: application/json\r\n",
                'content' => http_build_query($form, '', '&', PHP_QUERY_RFC3986),
                'timeout' => $this->timeout,
                'follow_location' => 0,
                'ignore_errors' => true,
            ],
            'ssl' => ['verify_peer' => true, 'verify_peer_name' => true],
        ]);
        $body = @file_get_contents($url, false, $context);
        if ($body === false) {
            throw new OAuthException('network');
        }
        // PHP 8.4 deprecates the magic $http_response_header.
        $headers = \function_exists('http_get_last_response_headers') ? (http_get_last_response_headers() ?? []) : $http_response_header;
        if ($headers === [] || preg_match('#^HTTP/\S+ (\d{3})#', $headers[0], $m) !== 1) {
            throw new OAuthException('network');
        }
        $decoded = json_decode($body, true);

        return ['status' => (int) $m[1], 'body' => \is_array($decoded) ? $decoded : []];
    }
}
