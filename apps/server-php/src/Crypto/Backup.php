<?php

declare(strict_types=1);

namespace Fma\Crypto;

/**
 * Backup encryption: the `fma.bk1` stream format.
 *
 * Layout: `fma.bk1` | salt[16] | chunk*, each chunk is
 * ciphertext(<= CHUNK_BYTES) | tag[16]; only the last one may be shorter.
 * Key = HKDF-SHA256(master key, salt, info `fma-backup-v1`); nonce =
 * 3 zero bytes | counter[8] (big endian) | final flag[1]. The final flag
 * detects truncation, the counter reordering. Memory use is bounded by one
 * chunk; plaintext of a chunk is only written after its tag verified.
 */
final class Backup
{
    public const CHUNK_BYTES = 65536;

    private const MAGIC = 'fma.bk1';
    private const SALT_BYTES = 16;

    public static function deriveKey(string $masterKey, string $salt): string
    {
        // PHP: hash_hkdf(algo, ikm, length, info, salt).
        return hash_hkdf('sha256', $masterKey, Envelope::KEY_BYTES, 'fma-backup-v1', $salt);
    }

    /**
     * Encrypts everything readable from `$in` into `$out`.
     *
     * @param resource $in
     * @param resource $out
     */
    public static function encryptStream(string $masterKey, $in, $out): void
    {
        $salt = random_bytes(self::SALT_BYTES);
        $key = self::deriveKey($masterKey, $salt);
        self::write($out, self::MAGIC . $salt);
        $counter = 0;
        // Read one chunk ahead: the last chunk must be sealed as final.
        $current = self::readExactly($in, self::CHUNK_BYTES);
        while (true) {
            $next = \strlen($current) === self::CHUNK_BYTES ? self::readExactly($in, self::CHUNK_BYTES) : '';
            $final = $next === '';
            self::write($out, Envelope::seal($key, self::nonce($counter++, $final), $current, ''));
            if ($final) {
                return;
            }
            $current = $next;
        }
    }

    /**
     * Decrypts a backup from `$in` into `$out`.
     *
     * @param resource $in
     * @param resource $out
     *
     * @throws BackupDecryptException
     */
    public static function decryptStream(string $masterKey, $in, $out): void
    {
        $header = self::readExactly($in, \strlen(self::MAGIC) + self::SALT_BYTES);
        if (\strlen($header) < \strlen(self::MAGIC) + self::SALT_BYTES) {
            throw new BackupDecryptException('not a backup file (too short)');
        }
        if (!str_starts_with($header, self::MAGIC)) {
            throw new BackupDecryptException('not a backup file (unknown format)');
        }
        $key = self::deriveKey($masterKey, substr($header, \strlen(self::MAGIC)));
        $sealedBytes = self::CHUNK_BYTES + Envelope::TAG_BYTES;
        $counter = 0;
        $current = self::readExactly($in, $sealedBytes);
        while (true) {
            // A full chunk followed by more data cannot be the final one.
            $next = \strlen($current) === $sealedBytes ? self::readExactly($in, $sealedBytes) : '';
            $final = $next === '';
            if (\strlen($current) < Envelope::TAG_BYTES) {
                throw new BackupDecryptException('backup file is truncated');
            }
            try {
                $plaintext = Envelope::open($key, self::nonce($counter++, $final), $current, '');
            } catch (CryptoException) {
                throw new BackupDecryptException(
                    'backup cannot be decrypted: wrong MASTER_KEY, or the file is corrupt or truncated',
                );
            }
            self::write($out, $plaintext);
            if ($final) {
                return;
            }
            $current = $next;
        }
    }

    private static function nonce(int $counter, bool $final): string
    {
        return "\0\0\0" . pack('J', $counter) . ($final ? "\1" : "\0");
    }

    /** @param resource $in */
    private static function readExactly($in, int $length): string
    {
        $buf = '';
        while (\strlen($buf) < $length && !feof($in)) {
            $part = fread($in, max(1, $length - \strlen($buf)));
            if ($part === false || $part === '') {
                if (feof($in)) {
                    break;
                }
                throw new CryptoException('backup stream read failed');
            }
            $buf .= $part;
        }

        return $buf;
    }

    /** @param resource $out */
    private static function write($out, string $data): void
    {
        if ($data !== '' && fwrite($out, $data) !== \strlen($data)) {
            throw new CryptoException('backup stream write failed');
        }
    }
}
