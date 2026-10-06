<?php

declare(strict_types=1);

namespace Fma\Install;

use Fma\Config;
use Fma\Crypto\CryptoException;
use Fma\Crypto\Envelope;
use Fma\Db\Database;

/**
 * Installation check for shared hosting (#109): everything the PHP backend
 * needs, reported as a list of named checks. Never reports secret values,
 * only whether they are set and valid.
 */
final class SystemCheck
{
    public const REQUIRED_EXTENSIONS = ['openssl', 'pdo_mysql', 'mbstring', 'json', 'hash', 'iconv'];
    public const OPTIONAL_EXTENSIONS = ['intl', 'curl', 'sodium', 'pcntl'];
    /** Outbound mail ports a host must allow (hosters often block them). */
    public const PORT_PROBES = [['imap.gmail.com', 993], ['smtp.gmail.com', 465], ['smtp.gmail.com', 587]];

    /** @param (callable(string, int): bool)|null $probe TCP probe override for tests */
    public function __construct(private readonly Config $config, private readonly mixed $probe = null) {}

    /** @return list<array{name: string, ok: bool, required: bool, detail: string}> */
    public function run(bool $network = true): array
    {
        $checks = [];
        $checks[] = self::check('PHP >= 8.2', version_compare(PHP_VERSION, '8.2.0', '>='), true, PHP_VERSION);
        foreach (self::REQUIRED_EXTENSIONS as $ext) {
            $checks[] = self::check("Extension {$ext}", \extension_loaded($ext), true, '');
        }
        foreach (self::OPTIONAL_EXTENSIONS as $ext) {
            $checks[] = self::check("Extension {$ext} (optional)", \extension_loaded($ext), false, '');
        }
        $checks[] = self::check('Argon2id (password_hash)', \defined('PASSWORD_ARGON2ID'), true, 'libargon2 or sodium');
        $checks[] = $this->masterKey();
        $checks[] = $this->database();
        $checks[] = $this->dataDir();
        if ($network) {
            foreach (self::PORT_PROBES as [$host, $port]) {
                $checks[] = self::check("Outbound {$host}:{$port}", $this->probe($host, $port), false, 'needed to reach mail providers');
            }
        }

        return $checks;
    }

    /** @param list<array{name: string, ok: bool, required: bool, detail: string}> $checks */
    public static function passed(array $checks): bool
    {
        foreach ($checks as $check) {
            if ($check['required'] && !$check['ok']) {
                return false;
            }
        }

        return true;
    }

    /** A fresh MASTER_KEY suggestion (base64 of 32 random bytes) for config.php. */
    public static function generateMasterKey(): string
    {
        return base64_encode(random_bytes(32));
    }

    /** @return array{name: string, ok: bool, required: bool, detail: string} */
    private function masterKey(): array
    {
        $value = $this->config->get('MASTER_KEY');
        if ($value === '') {
            return self::check('MASTER_KEY', false, true, 'not set');
        }
        try {
            Envelope::loadMasterKey($value);

            return self::check('MASTER_KEY', true, true, 'set (keep a separate backup!)');
        } catch (CryptoException) {
            return self::check('MASTER_KEY', false, true, 'must be 32 bytes base64');
        }
    }

    /** @return array{name: string, ok: bool, required: bool, detail: string} */
    private function database(): array
    {
        try {
            $pdo = Database::connect($this->config);
            $version = (string) Database::run($pdo, 'SELECT VERSION()')->fetchColumn();
            $isMaria = stripos($version, 'mariadb') !== false;
            $number = (string) preg_replace('/^(\d+\.\d+\.\d+).*$/', '$1', $version);
            $ok = $isMaria ? version_compare($number, '10.6.0', '>=') : version_compare($number, '8.0.1', '>=');

            return self::check('Database (MySQL >= 8.0.1 / MariaDB >= 10.6)', $ok, true, ($isMaria ? 'MariaDB ' : 'MySQL ') . $number);
        } catch (\Throwable $e) {
            // No message: it may contain host or user names.
            return self::check('Database (MySQL >= 8.0.1 / MariaDB >= 10.6)', false, true, 'connection failed (' . $e::class . ')');
        }
    }

    /** @return array{name: string, ok: bool, required: bool, detail: string} */
    private function dataDir(): array
    {
        $dir = $this->config->get('MAIL_DATA_DIR', \dirname(__DIR__, 2) . '/data');
        if (!is_dir($dir) && !@mkdir($dir, 0o700, true)) {
            return self::check('MAIL_DATA_DIR writable', false, true, 'cannot create directory');
        }
        $probe = $dir . '/.write-test-' . bin2hex(random_bytes(4));
        $ok = @file_put_contents($probe, 'x') === 1;
        @unlink($probe);

        return self::check('MAIL_DATA_DIR writable', $ok, true, $ok ? '' : 'not writable');
    }

    private function probe(string $host, int $port): bool
    {
        if (\is_callable($this->probe)) {
            return (bool) ($this->probe)($host, $port);
        }
        $socket = @stream_socket_client("tcp://{$host}:{$port}", $errno, $errstr, 5);
        if ($socket === false) {
            return false;
        }
        fclose($socket);

        return true;
    }

    /** @return array{name: string, ok: bool, required: bool, detail: string} */
    private static function check(string $name, bool $ok, bool $required, string $detail): array
    {
        return ['name' => $name, 'ok' => $ok, 'required' => $required, 'detail' => $detail];
    }
}
