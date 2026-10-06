<?php

declare(strict_types=1);

namespace Fma\Push;

/**
 * Web Push message encryption (RFC 8291) with the aes128gcm content coding
 * (RFC 8188) and the P-256 key handling VAPID needs, on ext-openssl only
 * (replaces the `web-push` package of apps/worker).
 *
 * One record per message: the push payload is tiny, the record size is
 * 4096 like web-push, the padding delimiter is 0x02 (last record).
 */
final class WebPushCrypto
{
    public const RECORD_SIZE = 4096;
    private const CURVE = 'prime256v1';
    /** DER prefix of a P-256 SubjectPublicKeyInfo (id-ecPublicKey, prime256v1, 65-byte BIT STRING). */
    private const SPKI_PREFIX = '3059301306072a8648ce3d020106082a8648ce3d030107034200';

    /**
     * Encrypts `plaintext` for a subscription.
     *
     * @param string $uaPublic raw p256dh (65 bytes, uncompressed point)
     * @param string $authSecret raw auth secret (16 bytes)
     * @param \OpenSSLAsymmetricKey|null $asPrivate ephemeral application server key (tests only; fresh otherwise)
     * @param string|null $salt 16 random bytes (tests only; fresh otherwise)
     *
     * @return string the request body: salt | rs | idlen | keyid (as_public) | ciphertext | tag
     */
    public static function encrypt(string $plaintext, string $uaPublic, string $authSecret, ?\OpenSSLAsymmetricKey $asPrivate = null, ?string $salt = null): string
    {
        if (\strlen($uaPublic) !== 65 || $uaPublic[0] !== "\x04" || \strlen($authSecret) !== 16) {
            throw new \InvalidArgumentException('invalid subscription keys');
        }
        $salt ??= random_bytes(16);
        if (\strlen($salt) !== 16) {
            throw new \InvalidArgumentException('salt must be 16 bytes');
        }
        $asPrivate ??= self::generateKey();
        $asPublic = self::publicPoint($asPrivate);

        $ecdhSecret = openssl_pkey_derive(self::publicKeyFromPoint($uaPublic), $asPrivate, 32);
        if ($ecdhSecret === false || \strlen($ecdhSecret) !== 32) {
            throw new \RuntimeException('ECDH failed');
        }
        // RFC 8291 3.4: IKM bound to both public keys; RFC 8188 2.2: CEK and nonce.
        $ikm = hash_hkdf('sha256', $ecdhSecret, 32, "WebPush: info\x00" . $uaPublic . $asPublic, $authSecret);
        $cek = hash_hkdf('sha256', $ikm, 16, "Content-Encoding: aes128gcm\x00", $salt);
        $nonce = hash_hkdf('sha256', $ikm, 12, "Content-Encoding: nonce\x00", $salt);

        $record = $plaintext . "\x02";
        if (\strlen($record) + 16 > self::RECORD_SIZE) {
            throw new \InvalidArgumentException('push payload too large');
        }
        $tag = '';
        $ciphertext = openssl_encrypt($record, 'aes-128-gcm', $cek, OPENSSL_RAW_DATA, $nonce, $tag, '', 16);
        if ($ciphertext === false) {
            throw new \RuntimeException('encryption failed');
        }

        return $salt . pack('N', self::RECORD_SIZE) . \chr(65) . $asPublic . $ciphertext . $tag;
    }

    public static function generateKey(): \OpenSSLAsymmetricKey
    {
        $key = openssl_pkey_new(['private_key_type' => OPENSSL_KEYTYPE_EC, 'curve_name' => self::CURVE]);
        if ($key === false) {
            throw new \RuntimeException('EC key generation failed');
        }

        return $key;
    }

    /** The uncompressed public point (0x04 | x | y) of an EC key. */
    public static function publicPoint(\OpenSSLAsymmetricKey $key): string
    {
        $details = openssl_pkey_get_details($key);
        $x = \is_array($details) ? ($details['ec']['x'] ?? null) : null;
        $y = \is_array($details) ? ($details['ec']['y'] ?? null) : null;
        if (!\is_string($x) || !\is_string($y)) {
            throw new \RuntimeException('not an EC key');
        }

        return "\x04" . str_pad($x, 32, "\x00", STR_PAD_LEFT) . str_pad($y, 32, "\x00", STR_PAD_LEFT);
    }

    /** Imports a raw uncompressed P-256 point as a public key. */
    public static function publicKeyFromPoint(string $point): \OpenSSLAsymmetricKey
    {
        if (\strlen($point) !== 65 || $point[0] !== "\x04") {
            throw new \InvalidArgumentException('invalid P-256 public key');
        }
        $key = openssl_pkey_get_public(self::pem('PUBLIC KEY', hex2bin(self::SPKI_PREFIX) . $point));
        if ($key === false) {
            throw new \InvalidArgumentException('invalid P-256 public key');
        }

        return $key;
    }

    /**
     * Imports a raw P-256 private scalar (32 bytes, the VAPID_PRIVATE_KEY
     * format) together with its public point as an ECPrivateKey (RFC 5915).
     */
    public static function privateKeyFromRaw(string $scalar, string $point): \OpenSSLAsymmetricKey
    {
        if (\strlen($scalar) !== 32 || \strlen($point) !== 65 || $point[0] !== "\x04") {
            throw new \InvalidArgumentException('invalid P-256 private key');
        }
        $der = "\x30\x77\x02\x01\x01\x04\x20" . $scalar
            . "\xa0\x0a\x06\x08\x2a\x86\x48\xce\x3d\x03\x01\x07"
            . "\xa1\x44\x03\x42\x00" . $point;
        $key = openssl_pkey_get_private(self::pem('EC PRIVATE KEY', $der));
        // A scalar that does not belong to the point is rejected.
        if ($key === false || !hash_equals($point, self::publicPoint($key))) {
            throw new \InvalidArgumentException('invalid P-256 private key');
        }

        return $key;
    }

    /** Converts a DER ECDSA signature (SEQUENCE of r, s) to raw r | s (JWS ES256). */
    public static function derToRawSignature(string $der): string
    {
        // SEQUENCE header: short length, or 0x81 long form (never longer for P-256).
        $pos = 2 + (isset($der[1]) && $der[1] === "\x81" ? 1 : 0);
        if (!isset($der[0]) || $der[0] !== "\x30") {
            throw new \RuntimeException('invalid DER signature');
        }
        $parts = [];
        for ($i = 0; $i < 2; ++$i) {
            if (!isset($der[$pos + 1]) || $der[$pos] !== "\x02") {
                throw new \RuntimeException('invalid DER signature');
            }
            $length = \ord($der[$pos + 1]);
            $value = substr($der, $pos + 2, $length);
            if ($length > 33 || \strlen($value) !== $length) {
                throw new \RuntimeException('invalid DER signature');
            }
            $parts[] = str_pad(ltrim($value, "\x00"), 32, "\x00", STR_PAD_LEFT);
            $pos += 2 + $length;
        }
        if ($pos !== \strlen($der) || \strlen($parts[0]) !== 32 || \strlen($parts[1]) !== 32) {
            throw new \RuntimeException('invalid DER signature');
        }

        return $parts[0] . $parts[1];
    }

    /** Converts a raw r | s signature back to DER (for openssl_verify). */
    public static function rawToDerSignature(string $raw): string
    {
        if (\strlen($raw) !== 64) {
            throw new \InvalidArgumentException('raw signature must be 64 bytes');
        }
        $int = static function (string $value): string {
            $value = ltrim($value, "\x00");
            if ($value === '' || \ord($value[0]) >= 0x80) {
                $value = "\x00" . $value;
            }

            return "\x02" . \chr(\strlen($value)) . $value;
        };
        $body = $int(substr($raw, 0, 32)) . $int(substr($raw, 32));

        return "\x30" . \chr(\strlen($body)) . $body;
    }

    public static function base64UrlEncode(string $bytes): string
    {
        return rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
    }

    /** Strict base64url (padding tolerated); null when invalid or empty. */
    public static function base64UrlDecode(string $value): ?string
    {
        $trimmed = rtrim($value, '=');
        if ($trimmed === '' || preg_match('/^[A-Za-z0-9_-]+$/', $trimmed) !== 1) {
            return null;
        }
        // The alphabet is checked above, so the non-strict decode cannot fail.
        return base64_decode(strtr($trimmed, '-_', '+/'));
    }

    private static function pem(string $label, string $der): string
    {
        return "-----BEGIN {$label}-----\n" . chunk_split(base64_encode($der), 64, "\n") . "-----END {$label}-----\n";
    }
}
