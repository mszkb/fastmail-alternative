<?php

declare(strict_types=1);

namespace Fma\Crypto;

/**
 * Envelope encryption for credentials and mail contents, byte-compatible
 * with packages/crypto/src/index.ts (ADR-0013, data model: see
 * docs/architecture/data-model.md#verschlüsselung).
 *
 * - One data key (DEK) per mail account (and per user), stored wrapped with
 *   the instance master key (KEK) from the environment/config only.
 * - AES-256-GCM, 12-byte nonce, 16-byte tag, field context as AAD.
 *
 * Formats:
 * - field: `fma.f1.` + base64(nonce[12] | ciphertext | tag[16])
 * - wrapped DEK: `fma.k1.` + base64(keyIdLen[1] | keyId | nonce[12] | ct | tag[16])
 * - bytes: `fma.b1.` | nonce[12] | ciphertext | tag[16]
 *
 * All failures throw CryptoException with a fixed message: neither keys nor
 * plaintext nor AAD (it may contain an endpoint) end up in error texts.
 */
final class Envelope
{
    public const KEY_BYTES = 32;
    public const NONCE_BYTES = 12;
    public const TAG_BYTES = 16;

    private const CIPHER = 'aes-256-gcm';
    private const FIELD_PREFIX = 'fma.f1.';
    private const BYTES_PREFIX = 'fma.b1.';
    private const WRAPPED_PREFIX = 'fma.k1.';

    /** Validates and decodes the base64 master key. */
    public static function loadMasterKey(string $base64Key): string
    {
        $key = self::base64Decode($base64Key);
        if ($key === null || \strlen($key) !== self::KEY_BYTES) {
            throw new CryptoException(
                'MASTER_KEY must be ' . self::KEY_BYTES . ' bytes base64-encoded, got '
                . ($key === null ? 'invalid base64' : \strlen($key) . ' bytes'),
            );
        }

        return $key;
    }

    /** Generates a fresh random data key (DEK). */
    public static function generateDataKey(): string
    {
        return random_bytes(self::KEY_BYTES);
    }

    /** Wraps a data key with the master key; `keyId` names the master key version. */
    public static function wrapDataKey(string $masterKey, string $dataKey, string $keyId): string
    {
        self::assertKey($masterKey);
        if (\strlen($dataKey) !== self::KEY_BYTES) {
            throw new CryptoException('data key must be ' . self::KEY_BYTES . ' bytes, got ' . \strlen($dataKey));
        }
        $keyIdLen = \strlen($keyId);
        if ($keyIdLen < 1 || $keyIdLen > 255) {
            throw new CryptoException('keyId must be 1-255 bytes');
        }
        $nonce = random_bytes(self::NONCE_BYTES);
        $sealed = self::seal($masterKey, $nonce, $dataKey, self::wrappedKeyAad($keyId));

        return self::WRAPPED_PREFIX . base64_encode(\chr($keyIdLen) . $keyId . $nonce . $sealed);
    }

    /**
     * Unwraps a data key.
     *
     * @return array{dataKey: string, keyId: string}
     */
    public static function unwrapDataKey(string $masterKey, string $wrapped): array
    {
        self::expectPrefix($wrapped, self::WRAPPED_PREFIX);
        $buf = self::base64Decode(substr($wrapped, \strlen(self::WRAPPED_PREFIX))) ?? '';
        $keyIdLen = $buf === '' ? 0 : \ord($buf[0]);
        if ($keyIdLen === 0) {
            throw new CryptoException('invalid wrapped key: empty keyId');
        }
        $keyId = substr($buf, 1, $keyIdLen);
        $nonce = substr($buf, 1 + $keyIdLen, self::NONCE_BYTES);
        $sealed = substr($buf, 1 + $keyIdLen + self::NONCE_BYTES);
        // Fixed 16-byte tag: a shortened tag must never be accepted as valid.
        if (\strlen($nonce) !== self::NONCE_BYTES || \strlen($sealed) < self::TAG_BYTES) {
            throw new CryptoException('invalid wrapped key: too short');
        }
        $dataKey = self::open($masterKey, $nonce, $sealed, self::wrappedKeyAad($keyId));
        if (\strlen($dataKey) !== self::KEY_BYTES) {
            throw new CryptoException('invalid wrapped key: wrong DEK length');
        }

        return ['dataKey' => $dataKey, 'keyId' => $keyId];
    }

    /** Unwraps an account/user DEK with the base64 master key from the config. */
    public static function unwrapAccountKey(string $masterKeyBase64, string $wrappedDek): string
    {
        return self::unwrapDataKey(self::loadMasterKey($masterKeyBase64), $wrappedDek)['dataKey'];
    }

    /** Encrypts a UTF-8 field value bound to `aad`. */
    public static function encryptField(string $dataKey, string $plaintext, string $aad): string
    {
        $nonce = random_bytes(self::NONCE_BYTES);

        return self::FIELD_PREFIX . base64_encode($nonce . self::seal($dataKey, $nonce, $plaintext, $aad));
    }

    /** Decrypts a field; throws if dataKey, aad or ciphertext do not match. */
    public static function decryptField(string $dataKey, string $envelope, string $aad): string
    {
        self::expectPrefix($envelope, self::FIELD_PREFIX);
        $buf = self::base64Decode(substr($envelope, \strlen(self::FIELD_PREFIX))) ?? '';

        return self::openRaw($dataKey, $buf, $aad);
    }

    /** Encrypts binary content: `fma.b1.` | nonce | ciphertext | tag. */
    public static function encryptBytes(string $dataKey, string $plaintext, string $aad): string
    {
        $nonce = random_bytes(self::NONCE_BYTES);

        return self::BYTES_PREFIX . $nonce . self::seal($dataKey, $nonce, $plaintext, $aad);
    }

    /**
     * Decrypts content written by encryptBytes. Also reads the legacy text
     * format (a field envelope holding the bytes as a latin1 string) and
     * returns the original bytes.
     */
    public static function decryptBytes(string $dataKey, string $envelope, string $aad): string
    {
        if (str_starts_with($envelope, self::FIELD_PREFIX)) {
            $buf = self::base64Decode(substr($envelope, \strlen(self::FIELD_PREFIX))) ?? '';

            return self::latin1FromUtf8(self::openRaw($dataKey, $buf, $aad));
        }
        if (!str_starts_with($envelope, self::BYTES_PREFIX)) {
            throw new CryptoException('invalid envelope: expected prefix ' . self::BYTES_PREFIX);
        }

        return self::openRaw($dataKey, substr($envelope, \strlen(self::BYTES_PREFIX)), $aad);
    }

    /** Derives an HMAC key (e.g. for subject_hash) from a DEK, independent from the encryption key. */
    public static function deriveHmacKey(string $dataKey, string $context): string
    {
        // PHP: hash_hkdf(algo, ikm, length, info, salt) - Node: hkdfSync(digest, ikm, salt, info, length).
        return hash_hkdf('sha256', $dataKey, 32, 'fma-hmac-v1', $context);
    }

    /** HMAC-SHA256 over a value with a derived key, hex-encoded. */
    public static function hmacValue(string $hmacKey, string $value): string
    {
        return hash_hmac('sha256', $value, $hmacKey);
    }

    /** @param 'subject'|'from'|'recipients'|'snippet'|'body'|'text' $field */
    public static function messageFieldAad(string $field, string $messageId): string
    {
        return "message.{$field}:{$messageId}";
    }

    public static function credentialAad(string $accountId): string
    {
        return "mail_account.credential:{$accountId}";
    }

    public static function outboxContentAad(string $outboxId): string
    {
        return "outbox_message.content:{$outboxId}";
    }

    public static function draftContentAad(string $draftId): string
    {
        return "draft.content:{$draftId}";
    }

    /** @param 'filename'|'content' $field */
    public static function uploadFieldAad(string $field, string $uploadId): string
    {
        return "attachment_upload.{$field}:{$uploadId}";
    }

    public static function pushKeysAad(string $endpoint): string
    {
        return "push_subscription.keys:{$endpoint}";
    }

    /** AES-256-GCM: returns ciphertext | tag. */
    public static function seal(string $key, string $nonce, string $plaintext, string $aad): string
    {
        self::assertKey($key);
        $tag = '';
        $ct = openssl_encrypt($plaintext, self::CIPHER, $key, OPENSSL_RAW_DATA, $nonce, $tag, $aad, self::TAG_BYTES);
        if ($ct === false) {
            throw new CryptoException('encryption failed');
        }

        return $ct . $tag;
    }

    /** AES-256-GCM: opens ciphertext | tag, throws on any mismatch. */
    public static function open(string $key, string $nonce, string $sealed, string $aad): string
    {
        self::assertKey($key);
        if (\strlen($nonce) !== self::NONCE_BYTES || \strlen($sealed) < self::TAG_BYTES) {
            throw new CryptoException('invalid envelope: too short');
        }
        $tag = substr($sealed, -self::TAG_BYTES);
        $ct = substr($sealed, 0, -self::TAG_BYTES);
        $plaintext = openssl_decrypt($ct, self::CIPHER, $key, OPENSSL_RAW_DATA, $nonce, $tag, $aad);
        if ($plaintext === false) {
            throw new CryptoException('decryption failed: wrong key, context or corrupt data');
        }

        return $plaintext;
    }

    /** nonce | ciphertext | tag -> plaintext. */
    private static function openRaw(string $key, string $buf, string $aad): string
    {
        if (\strlen($buf) < self::NONCE_BYTES + self::TAG_BYTES) {
            throw new CryptoException('invalid envelope: too short');
        }

        return self::open($key, substr($buf, 0, self::NONCE_BYTES), substr($buf, self::NONCE_BYTES), $aad);
    }

    /** UTF-8 bytes of a string whose code points are all <= 0xFF -> the latin1 bytes. */
    private static function latin1FromUtf8(string $utf8): string
    {
        if (preg_match('/^(?:[\x00-\x7F]|[\xC2\xC3][\x80-\xBF])*$/s', $utf8) !== 1) {
            throw new CryptoException('invalid legacy envelope: not a latin1 string');
        }

        return mb_convert_encoding($utf8, 'ISO-8859-1', 'UTF-8');
    }

    private static function wrappedKeyAad(string $keyId): string
    {
        return "fma.wrapped-dek:{$keyId}";
    }

    private static function expectPrefix(string $value, string $prefix): void
    {
        if (!str_starts_with($value, $prefix)) {
            throw new CryptoException("invalid envelope: expected prefix {$prefix}");
        }
    }

    private static function assertKey(string $key): void
    {
        if (\strlen($key) !== self::KEY_BYTES) {
            throw new CryptoException('key must be ' . self::KEY_BYTES . ' bytes');
        }
    }

    /**
     * Lenient base64 like Node's Buffer.from(s, 'base64'): accepts missing
     * padding and the URL-safe alphabet, ignores whitespace.
     */
    private static function base64Decode(string $value): ?string
    {
        $normalized = strtr(preg_replace('/\s+/', '', $value) ?? '', '-_', '+/');
        $normalized = rtrim($normalized, '=');
        if (preg_match('/^[A-Za-z0-9+\/]*$/', $normalized) !== 1) {
            return null;
        }
        $decoded = base64_decode($normalized . str_repeat('=', (4 - \strlen($normalized) % 4) % 4), true);

        return $decoded === false ? null : $decoded;
    }
}
