<?php

declare(strict_types=1);

namespace Fma\Mail;

use Fma\Config;
use Fma\Crypto\Envelope;
use Fma\Log\Logger;

/**
 * Read path of the encrypted raw mails in MAIL_DATA_DIR (ADR-0001):
 * message_body.storage_ref
 * is relative to the root, the file holds Envelope::encryptBytes() output
 * bound to the AAD `message.body:<messageId>`.
 * AES-GCM is opened in one piece (the tag is checked before any plaintext
 * is used), so the plaintext of a mail is always in memory once.
 */
final class RawStorage
{
    /** Parser, response and framework on top of ciphertext + plaintext. */
    private const MEMORY_HEADROOM = 16 * 1024 * 1024;

    public function __construct(private readonly Config $config, private readonly Logger $logger) {}

    public function root(): string
    {
        return $this->config->get('MAIL_DATA_DIR', \dirname(__DIR__, 2) . '/data');
    }

    /**
     * Reads and decrypts the raw source. Returns null when the file is
     * missing, outside the volume or cannot be decrypted (logged without
     * content).
     */
    public function read(string $dek, string $messageId, string $storageRef): ?string
    {
        $file = $this->path($messageId, $storageRef);
        if ($file === null) {
            return null;
        }
        $data = @file_get_contents($file);
        if ($data === false) {
            $this->logger->warn('raw message could not be read', ['messageId' => $messageId, 'code' => 'EIO']);

            return null;
        }
        try {
            return Envelope::decryptBytes($dek, $data, Envelope::messageFieldAad('body', $messageId));
        } catch (\Throwable) {
            $this->logger->warn('raw message could not be read', ['messageId' => $messageId, 'code' => 'decrypt']);

            return null;
        }
    }

    /**
     * Like read(), but returns the raw source as a php://temp stream (kept
     * in memory up to 2 MB, like MimeMail::parse()), so a caller can stream
     * a part of it. Peak memory is ciphertext + plaintext; when that does
     * not fit into memory_limit, throws RawTooLargeException instead of
     * running into a fatal error.
     *
     * @return resource|null
     */
    public function readStream(string $dek, string $messageId, string $storageRef): mixed
    {
        $file = $this->path($messageId, $storageRef);
        $size = $file === null ? false : @filesize($file);
        if ($file === null || $size === false) {
            return null;
        }
        $limit = self::memoryLimit();
        if ($limit !== null && memory_get_usage() + 2 * $size + self::MEMORY_HEADROOM > $limit) {
            $this->logger->warn('raw message too large for memory_limit', ['messageId' => $messageId, 'size' => $size, 'memoryLimit' => $limit]);

            throw new RawTooLargeException();
        }
        $handle = @fopen($file, 'rb');
        if ($handle === false) {
            $this->logger->warn('raw message could not be read', ['messageId' => $messageId, 'code' => 'EIO']);

            return null;
        }
        try {
            $raw = Envelope::decryptBytesFromStream($dek, $handle, $size, Envelope::messageFieldAad('body', $messageId));
        } catch (\Throwable) {
            $this->logger->warn('raw message could not be read', ['messageId' => $messageId, 'code' => 'decrypt']);

            return null;
        } finally {
            fclose($handle);
        }
        $stream = fopen('php://temp', 'r+b');
        if ($stream === false) {
            throw new \RuntimeException('cannot open temp stream');
        }
        fwrite($stream, $raw);
        rewind($stream);

        return $stream;
    }

    /** memory_limit in bytes, null when unlimited. */
    public static function memoryLimit(?string $value = null): ?int
    {
        $value = trim($value ?? (string) \ini_get('memory_limit'));
        if (preg_match('/^(\d+)\s*([kmg]?)$/i', $value, $m) !== 1) {
            return null;
        }
        $bytes = (int) $m[1] * match (strtolower($m[2])) {
            'g' => 1024 ** 3,
            'm' => 1024 ** 2,
            'k' => 1024,
            default => 1,
        };

        return $bytes > 0 ? $bytes : null;
    }

    /** Absolute path of a storage_ref inside the volume, null (logged) otherwise. */
    private function path(string $messageId, string $storageRef): ?string
    {
        $root = realpath($this->root());
        $file = $root === false ? false : realpath($root . \DIRECTORY_SEPARATOR . $storageRef);
        // Never leave the volume.
        if ($root === false || $file === false || !str_starts_with($file, $root . \DIRECTORY_SEPARATOR) || !is_file($file)) {
            $this->logger->warn('raw message could not be read', ['messageId' => $messageId, 'code' => 'ENOENT']);

            return null;
        }

        return $file;
    }
}
