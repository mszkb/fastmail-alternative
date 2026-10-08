<?php

declare(strict_types=1);

namespace Fma\Mail;

use Fma\Config;

/**
 * Transport policy for every IMAP/SMTP connection:
 * - ports: IMAP 143/993, SMTP 25/465/587/2525 plus MAIL_EXTRA_PORTS;
 * - SSRF: resolve once, every address public, connect to the checked
 *   address with the original hostname for SNI and the certificate check
 *   (no DNS rebinding); MAIL_ALLOW_PRIVATE_HOSTS=1 skips this;
 * - implicit TLS on 993/465, otherwise STARTTLS is mandatory before any
 *   credentials are sent; MAIL_INSECURE_TRANSPORT=1 (tests only) disables
 *   STARTTLS, certificate checks and the port allowlist.
 */
final class TransportPolicy
{
    public const PORTS = ['imap' => [143, 993], 'smtp' => [25, 465, 587, 2525]];

    /** @param (callable(string): list<string>)|null $resolve */
    public function __construct(
        public readonly bool $allowPrivateHosts = false,
        public readonly bool $insecureTransport = false,
        /** @var list<int> */
        public readonly array $extraPorts = [],
        private readonly mixed $resolve = null,
    ) {}

    public static function fromConfig(Config $config): self
    {
        $extra = [];
        foreach (explode(',', $config->get('MAIL_EXTRA_PORTS')) as $entry) {
            $port = trim($entry);
            if (preg_match('/^\d{1,5}$/', $port) === 1 && (int) $port >= 1 && (int) $port <= 65535) {
                $extra[] = (int) $port;
            }
        }

        return new self($config->bool('MAIL_ALLOW_PRIVATE_HOSTS'), $config->bool('MAIL_INSECURE_TRANSPORT'), $extra);
    }

    public static function isSecurePort(int $port): bool
    {
        return $port === 993 || $port === 465;
    }

    /** @param 'imap'|'smtp' $protocol */
    public function isAllowedPort(string $protocol, int $port): bool
    {
        return $this->insecureTransport || \in_array($port, self::PORTS[$protocol], true) || \in_array($port, $this->extraPorts, true);
    }

    /**
     * Checks port and host before anything connects.
     *
     * @param 'imap'|'smtp' $protocol
     *
     * @return array{address: string, servername: ?string} where to connect and the TLS name
     */
    public function resolveTarget(string $protocol, string $host, int $port): array
    {
        if (!$this->isAllowedPort($protocol, $port)) {
            throw new MailException('PORT_NOT_ALLOWED', 'port not allowed');
        }
        if ($this->allowPrivateHosts) {
            return ['address' => $host, 'servername' => $host];
        }
        $resolve = \is_callable($this->resolve) ? $this->resolve : null;
        $addresses = Ssrf::assertPublicHost($host, $resolve);
        // Prefer IPv4: containers and hosters often lack IPv6 routes.
        $chosen = $addresses[0];
        foreach ($addresses as $address) {
            if (filter_var($address, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) !== false) {
                $chosen = $address;
                break;
            }
        }

        return ['address' => $chosen, 'servername' => filter_var($host, FILTER_VALIDATE_IP) !== false ? null : $host];
    }
}
