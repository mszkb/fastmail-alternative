<?php

declare(strict_types=1);

namespace Fma\Push;

use Fma\Config;

/**
 * VAPID (RFC 8292) from VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT,
 * the raw base64url keys scripts/setup-env.sh writes (the format of the
 * VAPID spec, as used by common Web Push libraries). The JWT is ES256 with
 * aud = origin of the endpoint, exp = now + 12 h (web-push default).
 */
final class Vapid
{
    public const DEFAULT_SUBJECT = 'mailto:admin@example.com';
    private const EXPIRATION_SECONDS = 12 * 3600;

    private ?\OpenSSLAsymmetricKey $key = null;

    public function __construct(
        public readonly string $publicKey,
        private readonly string $privateKey,
        public readonly string $subject = self::DEFAULT_SUBJECT,
    ) {}

    /** Null when the instance has no VAPID keys (push is off). */
    public static function fromConfig(Config $config): ?self
    {
        $public = $config->get('VAPID_PUBLIC_KEY');
        $private = $config->get('VAPID_PRIVATE_KEY');
        if ($public === '' || $private === '') {
            return null;
        }

        return new self($public, $private, $config->get('VAPID_SUBJECT', self::DEFAULT_SUBJECT));
    }

    /**
     * The Authorization header value for a request to `endpoint`
     * ("vapid t=<jwt>, k=<public key>"). Throws on invalid keys or subject,
     * like web-push.
     */
    public function authorization(string $endpoint, ?int $now = null): string
    {
        $audience = Endpoint::origin($endpoint);
        if ($audience === null) {
            throw new \InvalidArgumentException('invalid push endpoint');
        }
        if (!str_starts_with($this->subject, 'mailto:') && !str_starts_with($this->subject, 'https:')) {
            throw new \InvalidArgumentException('VAPID subject must be a mailto: or https: URL');
        }
        $header = WebPushCrypto::base64UrlEncode(json_encode(['typ' => 'JWT', 'alg' => 'ES256'], JSON_THROW_ON_ERROR));
        $claims = WebPushCrypto::base64UrlEncode(json_encode([
            'aud' => $audience,
            'exp' => ($now ?? time()) + self::EXPIRATION_SECONDS,
            'sub' => $this->subject,
        ], JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES));
        $signingInput = "{$header}.{$claims}";
        $signature = '';
        if (!openssl_sign($signingInput, $signature, $this->key(), OPENSSL_ALGO_SHA256)) {
            throw new \RuntimeException('VAPID signing failed');
        }
        $jwt = $signingInput . '.' . WebPushCrypto::base64UrlEncode(WebPushCrypto::derToRawSignature($signature));

        return "vapid t={$jwt}, k={$this->publicKey}";
    }

    private function key(): \OpenSSLAsymmetricKey
    {
        if ($this->key === null) {
            $public = WebPushCrypto::base64UrlDecode($this->publicKey);
            $private = WebPushCrypto::base64UrlDecode($this->privateKey);
            if ($public === null || \strlen($public) !== 65 || $private === null || \strlen($private) !== 32) {
                throw new \InvalidArgumentException('invalid VAPID keys');
            }
            $this->key = WebPushCrypto::privateKeyFromRaw($private, $public);
        }

        return $this->key;
    }
}
