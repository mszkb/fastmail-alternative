<?php

declare(strict_types=1);

namespace Fma\Mail;

/**
 * SSRF protection for user-provided mail hosts, port of
 * packages/shared/src/ssrf.ts: every resolved address must be public
 * unicast; private, loopback, link-local, CGNAT, documentation, multicast
 * and IPv6 forms embedding such IPv4 addresses are rejected.
 */
final class Ssrf
{
    /**
     * Resolves the host (A and AAAA) and checks every address.
     *
     * @param (callable(string): list<string>)|null $resolve test override
     *
     * @return list<string> the checked addresses
     */
    public static function assertPublicHost(string $host, ?callable $resolve = null): array
    {
        if (filter_var($host, FILTER_VALIDATE_IP) !== false) {
            $addresses = [$host];
        } else {
            $addresses = ($resolve ?? self::resolve(...))($host);
            if ($addresses === []) {
                throw new MailException('ENOTFOUND', 'host not found');
            }
        }
        foreach ($addresses as $address) {
            if (!self::isPublicIp($address)) {
                throw new MailException('PRIVATE_HOST_BLOCKED', 'host resolves to a private address');
            }
        }

        return $addresses;
    }

    /** @return list<string> */
    public static function resolve(string $host): array
    {
        $records = @dns_get_record($host, DNS_A | DNS_AAAA);
        $addresses = [];
        foreach ($records ?: [] as $record) {
            $ip = $record['ip'] ?? $record['ipv6'] ?? null;
            if (\is_string($ip)) {
                $addresses[] = $ip;
            }
        }
        // getaddrinfo also reads /etc/hosts (like Node's dns.lookup); IPv4 only.
        if ($addresses === []) {
            $addresses = gethostbynamel($host) ?: [];
        }

        return $addresses;
    }

    public static function isPublicIp(string $address): bool
    {
        if (filter_var($address, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) !== false) {
            return self::isPublicIpv4($address);
        }
        if (str_contains($address, '%') || filter_var($address, FILTER_VALIDATE_IP, FILTER_FLAG_IPV6) === false) {
            return false;
        }

        return self::isPublicIpv6($address);
    }

    private static function isPublicIpv4(string $address): bool
    {
        [$a, $b] = array_map('intval', explode('.', $address));

        return !(
            $a === 0 // "this network"
            || $a === 10 // private
            || $a === 127 // loopback
            || ($a === 169 && $b === 254) // link-local
            || ($a === 172 && $b >= 16 && $b <= 31) // private
            || ($a === 192 && $b === 168) // private
            || ($a === 100 && $b >= 64 && $b <= 127) // CGNAT
            || ($a === 192 && $b === 0) // 192.0.0.0/24 + TEST-NET-1
            || ($a === 198 && ($b === 18 || $b === 19)) // benchmarking
            || ($a === 198 && $b === 51) // TEST-NET-2
            || ($a === 203 && $b === 0) // TEST-NET-3
            || $a >= 224 // multicast + reserved
        );
    }

    /** On the eight 16-bit groups, so every spelling of an address is classified alike. */
    private static function isPublicIpv6(string $address): bool
    {
        $packed = inet_pton($address);
        if ($packed === false || \strlen($packed) !== 16) {
            return false;
        }
        /** @var array<int, int> $g */
        $g = array_values((array) unpack('n8', $packed));
        $embedded = static fn(int $high, int $low): string => \sprintf('%d.%d.%d.%d', $high >> 8, $high & 0xFF, $low >> 8, $low & 0xFF);
        $ipv4 = $embedded($g[6], $g[7]);
        if ($g[0] === 0 && $g[1] === 0 && $g[2] === 0 && $g[3] === 0) {
            // ::/96 IPv4-compatible (incl. :: and ::1), ::ffff:0:0/96 mapped, ::ffff:0:0:0/96 translated.
            if (($g[4] === 0 && ($g[5] === 0 || $g[5] === 0xFFFF)) || ($g[4] === 0xFFFF && $g[5] === 0)) {
                return self::isPublicIpv4($ipv4);
            }

            return false;
        }
        if ($g[0] === 0x64 && $g[1] === 0xFF9B) {
            // NAT64 64:ff9b::/96 embeds the IPv4 target; 64:ff9b:1::/48 is local-use.
            return $g[2] === 0 && $g[3] === 0 && $g[4] === 0 && $g[5] === 0 && self::isPublicIpv4($ipv4);
        }
        if ($g[0] === 0x2002) {
            return self::isPublicIpv4($embedded($g[1], $g[2])); // 6to4
        }

        return !(
            ($g[0] === 0x2001 && $g[1] === 0) // Teredo
            || ($g[0] === 0x2001 && $g[1] === 0xDB8) // documentation
            || ($g[0] === 0x3FFF && ($g[1] & 0xF000) === 0) // documentation 3fff::/20
            || ($g[0] === 0x100 && $g[1] === 0 && $g[2] === 0 && $g[3] === 0) // discard-only
            || ($g[0] & 0xFFC0) === 0xFE80 // link-local
            || ($g[0] & 0xFFC0) === 0xFEC0 // site-local
            || ($g[0] & 0xFE00) === 0xFC00 // unique local
            || ($g[0] & 0xFF00) === 0xFF00 // multicast
        );
    }
}
