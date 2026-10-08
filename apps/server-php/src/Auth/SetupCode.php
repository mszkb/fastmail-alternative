<?php

declare(strict_types=1);

namespace Fma\Auth;

use Fma\Config;
use Fma\Db\Database;
use Fma\Log\Logger;

/**
 * Setup code for the first-run setup:
 * while no user exists, POST /api/auth/setup needs this code.
 *
 * - `SETUP_TOKEN` from the configuration, if set (never logged), else
 * - a random code (6 groups of 4 Base32 characters, 120 bits), generated on
 *   demand and written to the log once. PHP keeps no memory between
 *   requests, so only its SHA-256 is stored (table `app_state`).
 *   `php bin/setup-code.php` prints a new one (hosts without log access).
 *
 * Comparison ignores case, spaces and dashes.
 */
final class SetupCode
{
    private const STATE_KEY = 'setup_code_sha256';
    private const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

    public function __construct(
        private readonly Config $config,
        private readonly Database $db,
        private readonly Logger $logger,
    ) {}

    /** Makes sure a code exists; logs a newly generated one. Call only while no user exists. */
    public function ensure(): void
    {
        if ($this->configured() !== null || $this->storedHash() !== null) {
            return;
        }
        $code = $this->regenerate();
        // Deliberately logged: the operator needs it once to claim the instance.
        $this->logger->warn("FIRST-RUN SETUP CODE: {$code} (enter it on the setup page; valid until setup is done)", ['event' => 'setup.pending']);
    }

    /** Replaces the stored code with a new random one and returns it. */
    public function regenerate(): string
    {
        $bytes = random_bytes(24);
        $code = '';
        for ($i = 0; $i < 24; ++$i) {
            $code .= ($i > 0 && $i % 4 === 0 ? '-' : '') . self::BASE32[\ord($bytes[$i]) % 32];
        }
        Database::run(
            $this->db->pdo(),
            'INSERT INTO app_state (name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)',
            [self::STATE_KEY, self::digest($code)],
        );

        return $code;
    }

    public function matches(mixed $given): bool
    {
        $expected = ($configured = $this->configured()) !== null ? self::digest($configured) : $this->storedHash();
        if ($expected === null || !\is_string($given) || \strlen($given) > 200) {
            return false;
        }

        return hash_equals($expected, self::digest($given));
    }

    /** Drops the generated code after a successful setup. */
    public function discard(): void
    {
        Database::run($this->db->pdo(), 'DELETE FROM app_state WHERE name = ?', [self::STATE_KEY]);
    }

    private function configured(): ?string
    {
        $token = trim($this->config->get('SETUP_TOKEN'));

        return $token === '' ? null : $token;
    }

    private function storedHash(): ?string
    {
        $value = Database::run($this->db->pdo(), 'SELECT value FROM app_state WHERE name = ?', [self::STATE_KEY])->fetchColumn();

        return \is_string($value) ? $value : null;
    }

    private static function digest(string $code): string
    {
        return hash('sha256', strtoupper((string) preg_replace('/[\s-]/', '', $code)));
    }
}
