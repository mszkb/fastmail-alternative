<?php

declare(strict_types=1);

namespace Fma\Push;

/**
 * Push endpoint URL helpers. Endpoints are capability URLs: only the host
 * (display, logs) and a short hash (logs) ever leave the server.
 */
final class Endpoint
{
    /**
     * Parsed absolute http(s) URL, or null.
     *
     * @return array{scheme: string, host: string, port: int, hasCredentials: bool, path: string}|null
     *   host without IPv6 brackets, lowercase; path including the query
     */
    public static function parse(string $endpoint): ?array
    {
        // Only printable ASCII: the column is ascii and WHATWG URLs never keep raw spaces/controls.
        if ($endpoint === '' || preg_match('/^[\x21-\x7e]+$/', $endpoint) !== 1) {
            return null;
        }
        $parts = parse_url($endpoint);
        if (!\is_array($parts) || !isset($parts['scheme'], $parts['host']) || $parts['host'] === '') {
            return null;
        }
        $scheme = strtolower($parts['scheme']);
        if ($scheme !== 'https' && $scheme !== 'http') {
            return null;
        }
        $host = strtolower($parts['host']);
        if (str_starts_with($host, '[')) {
            $host = substr($host, 1, -1);
            if (filter_var($host, FILTER_VALIDATE_IP, FILTER_FLAG_IPV6) === false) {
                return null;
            }
        }

        return [
            'scheme' => $scheme,
            'host' => $host,
            'port' => $parts['port'] ?? ($scheme === 'https' ? 443 : 80),
            'hasCredentials' => isset($parts['user']) || isset($parts['pass']),
            'path' => ($parts['path'] ?? '/') . (isset($parts['query']) ? '?' . $parts['query'] : ''),
        ];
    }

    /** URL.host: hostname (IPv6 in brackets) plus a non-default port; '' when invalid. */
    public static function host(string $endpoint): string
    {
        $url = self::parse($endpoint);
        if ($url === null) {
            return '';
        }
        $host = str_contains($url['host'], ':') ? "[{$url['host']}]" : $url['host'];
        $default = $url['scheme'] === 'https' ? 443 : 80;

        return $url['port'] === $default ? $host : "{$host}:{$url['port']}";
    }

    /** URL.origin, the VAPID audience. */
    public static function origin(string $endpoint): ?string
    {
        $url = self::parse($endpoint);

        return $url === null ? null : "{$url['scheme']}://" . self::host($endpoint);
    }

    /**
     * Log-safe reference: push service host and a short hash.
     *
     * @return array{pushHost: string, endpointHash: string}
     */
    public static function ref(string $endpoint): array
    {
        $host = self::host($endpoint);

        return ['pushHost' => $host === '' ? 'invalid' : $host, 'endpointHash' => substr(hash('sha256', $endpoint), 0, 12)];
    }
}
