<?php

declare(strict_types=1);

namespace Fma\Security;

use Psr\Http\Message\ServerRequestInterface;

/**
 * Client IP behind the reverse proxy:
 * only a direct peer with a loopback/private address is trusted as proxy,
 * and then only the right-most X-Forwarded-For entry (the address that
 * proxy saw) is used. Requests from public addresses ignore the header.
 */
final class ClientIp
{
    public static function fromRequest(ServerRequestInterface $request): string
    {
        $server = $request->getServerParams();
        $peer = \is_string($server['REMOTE_ADDR'] ?? null) ? $server['REMOTE_ADDR'] : '';
        if ($peer === '' || !self::isPrivate($peer)) {
            return $peer;
        }
        $forwarded = $request->getHeaderLine('X-Forwarded-For');
        if ($forwarded === '') {
            return $peer;
        }
        $entries = explode(',', $forwarded);
        $last = trim($entries[\count($entries) - 1]);

        return filter_var($last, FILTER_VALIDATE_IP) !== false ? $last : $peer;
    }

    public static function isPrivate(string $address): bool
    {
        if (preg_match('/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i', $address, $m) === 1) {
            $address = $m[1];
        }
        if (filter_var($address, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) !== false) {
            return str_starts_with($address, '127.')
                || filter_var($address, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE) === false;
        }
        if (filter_var($address, FILTER_VALIDATE_IP, FILTER_FLAG_IPV6) !== false) {
            $bin = (string) inet_pton($address);

            return $bin === inet_pton('::1') || (\ord($bin[0]) & 0xFE) === 0xFC;
        }

        return false;
    }
}
