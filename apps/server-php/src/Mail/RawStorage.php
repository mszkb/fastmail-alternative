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
 */
final class RawStorage
{
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
        $root = realpath($this->root());
        $file = $root === false ? false : realpath($root . \DIRECTORY_SEPARATOR . $storageRef);
        // Never leave the volume.
        if ($root === false || $file === false || !str_starts_with($file, $root . \DIRECTORY_SEPARATOR) || !is_file($file)) {
            $this->logger->warn('raw message could not be read', ['messageId' => $messageId, 'code' => 'ENOENT']);

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
}
