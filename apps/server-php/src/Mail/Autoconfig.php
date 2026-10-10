<?php

declare(strict_types=1);

namespace Fma\Mail;

/**
 * Detects IMAP/SMTP settings for an address domain without a preset (#165).
 * Sources in this order, the first usable result wins:
 * 1. the provider's autoconfig: https://autoconfig.<domain>/mail/config-v1.1.xml,
 *    then https://<domain>/.well-known/autoconfig/mail/config-v1.1.xml;
 * 2. the Thunderbird ISPDB (https://autoconfig.thunderbird.net/v1.1/<domain>),
 *    unless disabled (AUTOCONFIG_ISPDB=0);
 * 3. DNS SRV records after RFC 6186/8314 (_imaps, _imap, _submissions, _submission);
 * 4. the MX host's base domain (e.g. google.com for Google Workspace on an
 *    own domain) looked up in the ISPDB.
 *
 * Only the domain leaves the server - never the address or the password.
 * The result only pre-fills the account form; the connection test confirms
 * it. Plain-text servers are skipped, implicit TLS is preferred over STARTTLS.
 */
final class Autoconfig
{
    public const ISPDB_URL = 'https://autoconfig.thunderbird.net/v1.1/';
    public const DEADLINE_SECONDS = 8.0;
    public const REQUEST_TIMEOUT_SECONDS = 4.0;
    /** DNS hostname labels (letters, digits, inner hyphens), at least two labels. */
    public const DOMAIN_RE = '/^(?=.{1,253}\z)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+\z/';
    /** Second-level labels under which registrations sit one level deeper (example.co.uk). */
    private const SECOND_LEVEL = ['co', 'com', 'net', 'org', 'ac', 'gov', 'edu', 'or', 'ne'];

    /** @var callable(string, int): list<array<string, mixed>> */
    private $dns;

    /** @param (callable(string, int): list<array<string, mixed>>)|null $dns test override for dns_get_record */
    public function __construct(
        private readonly HttpsGetter $http,
        private readonly bool $useIspdb = true,
        ?callable $dns = null,
        private readonly float $deadlineSeconds = self::DEADLINE_SECONDS,
    ) {
        $this->dns = $dns ?? static fn(string $name, int $type): array => @dns_get_record($name, $type) ?: [];
    }

    /**
     * @return array{source: string, imap: ?array{host: string, port: int}, smtp: ?array{host: string, port: int}, username: 'address'|'localpart'}|null
     */
    public function discover(string $domain): ?array
    {
        $domain = strtolower(rtrim(trim($domain), '.'));
        if (preg_match(self::DOMAIN_RE, $domain) !== 1) {
            return null;
        }
        $deadline = microtime(true) + $this->deadlineSeconds;
        $urls = [
            'autoconfig' => "https://autoconfig.{$domain}/mail/config-v1.1.xml",
            'well-known' => "https://{$domain}/.well-known/autoconfig/mail/config-v1.1.xml",
        ];
        if ($this->useIspdb) {
            $urls['ispdb'] = self::ISPDB_URL . $domain;
        }
        foreach ($urls as $source => $url) {
            $found = $this->fromUrl($url, $domain, $deadline);
            if ($found !== null) {
                return ['source' => $source] + $found;
            }
        }
        $srv = $this->fromSrv($domain);
        if ($srv !== null) {
            return ['source' => 'srv'] + $srv;
        }
        if ($this->useIspdb) {
            $base = $this->mxBaseDomain($domain);
            if ($base !== null && $base !== $domain) {
                $found = $this->fromUrl(self::ISPDB_URL . $base, $domain, $deadline);
                if ($found !== null) {
                    return ['source' => 'mx'] + $found;
                }
            }
        }

        return null;
    }

    /**
     * Parses a Thunderbird autoconfig document (config-v1.1.xml).
     *
     * @return array{imap: ?array{host: string, port: int}, smtp: ?array{host: string, port: int}, username: 'address'|'localpart'}|null
     */
    public static function parse(string $xml, string $domain): ?array
    {
        // No DTDs: entity tricks are refused before the parser sees them.
        if ($xml === '' || stripos($xml, '<!DOCTYPE') !== false || stripos($xml, '<!ENTITY') !== false) {
            return null;
        }
        $previous = libxml_use_internal_errors(true);
        try {
            $doc = simplexml_load_string($xml, \SimpleXMLElement::class, LIBXML_NONET | LIBXML_NOCDATA);
        } finally {
            libxml_clear_errors();
            libxml_use_internal_errors($previous);
        }
        if ($doc === false || !isset($doc->emailProvider)) {
            return null;
        }
        $provider = $doc->emailProvider;
        $imap = self::bestServer($provider->incomingServer, 'imap', $domain);
        $smtp = self::bestServer($provider->outgoingServer, 'smtp', $domain);
        if ($imap === null) {
            return null;
        }

        return ['imap' => $imap['server'], 'smtp' => $smtp['server'] ?? null, 'username' => $imap['username']];
    }

    /**
     * @return array{server: array{host: string, port: int}, username: 'address'|'localpart'}|null
     */
    private static function bestServer(?\SimpleXMLElement $servers, string $type, string $domain): ?array
    {
        $best = null;
        $bestRank = 0;
        foreach ($servers ?? [] as $server) {
            if ((string) $server['type'] !== $type) {
                continue;
            }
            $rank = match (strtoupper(trim((string) $server->socketType))) {
                'SSL' => 2,
                'STARTTLS' => 1,
                default => 0, // plain: never offered
            };
            $host = strtolower(trim(str_ireplace('%EMAILDOMAIN%', $domain, (string) $server->hostname)));
            $port = (int) trim((string) $server->port);
            if ($rank <= $bestRank || preg_match(self::DOMAIN_RE, $host) !== 1 || $port < 1 || $port > 65535) {
                continue;
            }
            $username = strtoupper(trim((string) $server->username)) === '%EMAILLOCALPART%' ? 'localpart' : 'address';
            $best = ['server' => ['host' => $host, 'port' => $port], 'username' => $username];
            $bestRank = $rank;
        }

        return $best;
    }

    /** @return array{imap: ?array{host: string, port: int}, smtp: ?array{host: string, port: int}, username: 'address'}|null */
    private function fromSrv(string $domain): ?array
    {
        $imap = $this->srv("_imaps._tcp.{$domain}") ?? $this->srv("_imap._tcp.{$domain}");
        if ($imap === null) {
            return null;
        }
        $smtp = $this->srv("_submissions._tcp.{$domain}") ?? $this->srv("_submission._tcp.{$domain}");

        return ['imap' => $imap, 'smtp' => $smtp, 'username' => 'address'];
    }

    /** Highest-priority SRV target; "." means the service is not offered (RFC 2782). */
    /** @return array{host: string, port: int}|null */
    private function srv(string $name): ?array
    {
        $records = array_filter(($this->dns)($name, DNS_SRV), static fn(array $r): bool => isset($r['target'], $r['port']));
        usort($records, static fn(array $a, array $b): int => ((int) ($a['pri'] ?? 0) <=> (int) ($b['pri'] ?? 0)) ?: ((int) ($b['weight'] ?? 0) <=> (int) ($a['weight'] ?? 0)));
        foreach ($records as $record) {
            $host = strtolower(rtrim((string) $record['target'], '.'));
            $port = (int) $record['port'];
            if (preg_match(self::DOMAIN_RE, $host) === 1 && $port >= 1 && $port <= 65535) {
                return ['host' => $host, 'port' => $port];
            }
        }

        return null;
    }

    /** Base domain of the preferred MX host, e.g. aspmx.l.google.com -> google.com. */
    private function mxBaseDomain(string $domain): ?string
    {
        $records = array_filter(($this->dns)($domain, DNS_MX), static fn(array $r): bool => isset($r['target']));
        usort($records, static fn(array $a, array $b): int => (int) ($a['pri'] ?? 0) <=> (int) ($b['pri'] ?? 0));
        $host = strtolower(rtrim((string) ($records[0]['target'] ?? ''), '.'));
        if (preg_match(self::DOMAIN_RE, $host) !== 1) {
            return null;
        }

        return self::baseDomain($host);
    }

    public static function baseDomain(string $host): string
    {
        $labels = explode('.', $host);
        $count = \count($labels);
        $take = $count >= 3 && \strlen($labels[$count - 1]) === 2 && \in_array($labels[$count - 2], self::SECOND_LEVEL, true) ? 3 : 2;

        return implode('.', \array_slice($labels, -min($take, $count)));
    }

    /** @return array{imap: ?array{host: string, port: int}, smtp: ?array{host: string, port: int}, username: 'address'|'localpart'}|null */
    private function fromUrl(string $url, string $domain, float $deadline): ?array
    {
        $remaining = min(self::REQUEST_TIMEOUT_SECONDS, $deadline - microtime(true));
        if ($remaining <= 0) {
            return null;
        }
        $body = $this->http->get($url, $remaining);

        return $body === null ? null : self::parse($body, $domain);
    }
}
