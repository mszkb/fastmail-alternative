<?php

declare(strict_types=1);

namespace Fma\Install;

/**
 * Secrets generated on the first start of the docker compose stack (#164,
 * ADR-0016), so `docker compose up` works without scripts/setup-env.sh.
 *
 * The one-shot `secrets` service runs ensure() as root before MariaDB:
 * - `secrets.json` (owner www-data, 0600): MASTER_KEY, the VAPID key pair
 *   and DB_PASSWORD - only values the environment does not set. A value
 *   once written is never replaced; values from the environment (.env) are
 *   never written here, so there is never a second master key.
 * - `mariadb_password` (root, 0400) for MARIADB_PASSWORD_FILE: the
 *   MARIADB_PASSWORD from the environment if set, else the generated one.
 *
 * Config::load() reads `secrets.json` (SECRETS_FILE) with the lowest
 * priority: environment and config.php always win. Values are never logged.
 */
final class GeneratedSecrets
{
    public const FILE = 'secrets.json';
    public const MARIADB_FILE = 'mariadb_password';
    /** Names this file may provide; anything else in it is ignored. */
    public const NAMES = ['MASTER_KEY', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'DB_PASSWORD'];

    /**
     * Creates what is missing in $dir; returns the names generated now.
     *
     * @param array<string, string> $env  the environment (.env values passed by compose)
     * @param array{0: int, 1: int}|null $owner uid/gid of secrets.json (www-data), null = unchanged
     *
     * @return list<string>
     */
    public static function ensure(string $dir, array $env, ?array $owner = null): array
    {
        if (!is_dir($dir) && !mkdir($dir, 0o700, true) && !is_dir($dir)) {
            throw new \RuntimeException('cannot create the secrets directory');
        }
        $file = $dir . '/' . self::FILE;
        $stored = self::load($file);
        $given = static fn(string $name): bool => ($env[$name] ?? '') !== '';
        $generated = [];

        if (!$given('MASTER_KEY') && !isset($stored['MASTER_KEY'])) {
            $stored['MASTER_KEY'] = base64_encode(random_bytes(32));
            $generated[] = 'MASTER_KEY';
        }
        // A pair or nothing: half a pair from .env must not be completed with a mismatching key.
        $vapidGiven = $given('VAPID_PUBLIC_KEY') || $given('VAPID_PRIVATE_KEY');
        if (!$vapidGiven && !isset($stored['VAPID_PUBLIC_KEY'], $stored['VAPID_PRIVATE_KEY'])) {
            $vapid = Installer::generateVapidKeys();
            if ($vapid !== null) {
                $stored['VAPID_PUBLIC_KEY'] = $vapid['public'];
                $stored['VAPID_PRIVATE_KEY'] = $vapid['private'];
                $generated[] = 'VAPID_PUBLIC_KEY';
                $generated[] = 'VAPID_PRIVATE_KEY';
            }
        }
        if (!$given('MARIADB_PASSWORD') && !isset($stored['DB_PASSWORD'])) {
            $stored['DB_PASSWORD'] = rtrim(strtr(base64_encode(random_bytes(24)), '+/', '-_'), '=');
            $generated[] = 'DB_PASSWORD';
        }

        if ($generated !== []) {
            self::write($file, json_encode($stored, JSON_THROW_ON_ERROR | JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n", 0o600);
        }
        if ($owner !== null && is_file($file)) {
            chown($file, $owner[0]);
            chgrp($file, $owner[1]);
            chown($dir, $owner[0]);
            chgrp($dir, $owner[1]);
        }
        // MariaDB reads its password file as root before switching users.
        $mariadb = $given('MARIADB_PASSWORD') ? $env['MARIADB_PASSWORD'] : ($stored['DB_PASSWORD'] ?? '');
        $mariadbFile = $dir . '/' . self::MARIADB_FILE;
        if ($mariadb !== '' && (!is_file($mariadbFile) || file_get_contents($mariadbFile) !== $mariadb)) {
            self::write($mariadbFile, $mariadb, 0o400);
        }

        return $generated;
    }

    /**
     * Values of a secrets.json; missing or unreadable file = none.
     *
     * @return array<string, string>
     */
    public static function load(string $file): array
    {
        if ($file === '' || !is_file($file) || !is_readable($file)) {
            return [];
        }
        try {
            $data = json_decode((string) file_get_contents($file), true, 4, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            throw new \RuntimeException('secrets file is not valid JSON');
        }
        $values = [];
        foreach (\is_array($data) ? $data : [] as $name => $value) {
            if (\in_array($name, self::NAMES, true) && \is_string($value) && $value !== '') {
                $values[$name] = $value;
            }
        }

        return $values;
    }

    /** Atomic write with restrictive permissions from the start (umask 077). */
    private static function write(string $file, string $content, int $mode): void
    {
        $tmp = $file . '.tmp';
        $umask = umask(0o077);
        try {
            if (is_file($tmp)) {
                unlink($tmp);
            }
            if (file_put_contents($tmp, $content) === false || !chmod($tmp, $mode) || !rename($tmp, $file)) {
                throw new \RuntimeException('cannot write ' . basename($file));
            }
        } finally {
            umask($umask);
        }
    }
}
