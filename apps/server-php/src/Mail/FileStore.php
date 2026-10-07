<?php

declare(strict_types=1);

namespace Fma\Mail;

use Fma\Config;

/**
 * Layout of the mail-data directory, same as the Node worker (ADR-0001):
 * `<MAIL_DATA_DIR>/<account uuid>/<message uuid>/raw.eml.enc`, with
 * `message_body.storage_ref` = `<account>/<message>/raw.eml.enc` relative
 * to the root. Only paths, deletion and scanning live here; nothing is
 * ever removed outside the root.
 */
final class FileStore
{
    public const RAW_FILE = 'raw.eml.enc';
    private const UUID_RE = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z/';

    private readonly string $root;

    public function __construct(string $root)
    {
        $this->root = rtrim($root, '/\\') ?: '/';
    }

    /** MAIL_DATA_DIR, default `apps/server-php/data` (outside the webroot `public/`). */
    public static function fromConfig(Config $config): self
    {
        return new self($config->get('MAIL_DATA_DIR', \dirname(__DIR__, 2) . '/data'));
    }

    public function root(): string
    {
        return $this->root;
    }

    public static function isId(string $name): bool
    {
        return preg_match(self::UUID_RE, $name) === 1;
    }

    /** storage_ref of a message's raw file. */
    public static function storageRef(string $accountId, string $messageId): string
    {
        return "{$accountId}/{$messageId}/" . self::RAW_FILE;
    }

    public function accountDir(string $accountId): ?string
    {
        return self::isId($accountId) ? "{$this->root}/{$accountId}" : null;
    }

    /**
     * Absolute message directory of a storage_ref, null unless it has our
     * layout `<uuid>/<uuid>/<file>` (no traversal out of the root).
     */
    public function messageDirOf(string $storageRef): ?string
    {
        $parts = explode('/', str_replace('\\', '/', $storageRef));
        if (\count($parts) !== 3 || !self::isId($parts[0]) || !self::isId($parts[1]) || $parts[2] === '' || $parts[2] === '.' || $parts[2] === '..') {
            return null;
        }

        return "{$this->root}/{$parts[0]}/{$parts[1]}";
    }

    /** Whether storage_ref points into the directory <account>/<message>. */
    public static function refersTo(string $storageRef, string $accountId, string $messageId): bool
    {
        $parts = explode('/', str_replace('\\', '/', $storageRef));

        return \count($parts) === 3 && $parts[0] === $accountId && $parts[1] === $messageId;
    }

    /** Removes the message directory of a storage_ref (no-op for foreign refs). */
    public function removeMessageDir(string $storageRef): void
    {
        $dir = $this->messageDirOf($storageRef);
        if ($dir !== null) {
            self::removeTree($dir);
        }
    }

    /** Removes the directory of an account (no-op for invalid ids). */
    public function removeAccountDir(string $accountId): void
    {
        $dir = $this->accountDir($accountId);
        if ($dir !== null) {
            self::removeTree($dir);
        }
    }

    /**
     * Streams the entries of a directory that look like our ids (uuid
     * directories); nothing when it does not exist.
     *
     * @return \Generator<int, string>
     */
    public function scanIds(?string $accountId = null): \Generator
    {
        $dir = $accountId === null ? $this->root : $this->accountDir($accountId);
        if ($dir === null || !is_dir($dir)) {
            return;
        }
        $handle = @opendir($dir);
        if ($handle === false) {
            return;
        }
        try {
            while (($name = readdir($handle)) !== false) {
                if (self::isId($name) && is_dir("{$dir}/{$name}") && !is_link("{$dir}/{$name}")) {
                    yield $name;
                }
            }
        } finally {
            closedir($handle);
        }
    }

    /** Latest mtime of a directory and its raw file (unix seconds), null if gone. */
    public static function newestMtime(string $dir): ?int
    {
        clearstatcache(true, $dir);
        $dirTime = @filemtime($dir);
        if ($dirTime === false) {
            return null;
        }
        $file = "{$dir}/" . self::RAW_FILE;
        clearstatcache(true, $file);
        $fileTime = @filemtime($file);

        return max($dirTime, $fileTime === false ? 0 : $fileTime);
    }

    /** rm -rf without following symlinks; missing paths are fine. */
    public static function removeTree(string $path): void
    {
        if (is_link($path) || is_file($path)) {
            @unlink($path);

            return;
        }
        if (!is_dir($path)) {
            return;
        }
        $handle = @opendir($path);
        if ($handle !== false) {
            while (($name = readdir($handle)) !== false) {
                if ($name !== '.' && $name !== '..') {
                    self::removeTree("{$path}/{$name}");
                }
            }
            closedir($handle);
        }
        @rmdir($path);
    }
}
