<?php

declare(strict_types=1);

namespace Fma;

use Fma\Install\GeneratedSecrets;

/**
 * Configuration (ADR-0013): environment variables, or a `config.php`
 * outside the web root for hosters without environment variables. The
 * environment wins. Variables: docs/operations/configuration.md.
 *
 * `config.php` returns an array with the same names as the environment,
 * e.g. `return ['MASTER_KEY' => '...', 'DATABASE_URL' => 'mysql://...'];`.
 * Lowest priority: secrets generated on the first docker start
 * (SECRETS_FILE, Fma\Install\GeneratedSecrets, #164). Values are never logged.
 */
final class Config
{
    /**
     * @param array<string, string> $values
     * @param list<string>          $generated names whose value came from SECRETS_FILE
     */
    private function __construct(private readonly array $values, private readonly array $generated = []) {}

    /**
     * @param array<string, string>|null $env  defaults to getenv()
     * @param string|null                $file defaults to FMA_CONFIG or ../config.php
     */
    public static function load(?array $env = null, ?string $file = null): self
    {
        $env ??= self::environment();
        $file ??= ($env['FMA_CONFIG'] ?? '') !== '' ? $env['FMA_CONFIG'] : \dirname(__DIR__) . '/config.php';
        $values = GeneratedSecrets::load($env['SECRETS_FILE'] ?? '');
        $generated = array_keys($values);
        if (is_file($file)) {
            $fromFile = require $file;
            if (!\is_array($fromFile)) {
                throw new \RuntimeException('config.php must return an array');
            }
            foreach ($fromFile as $key => $value) {
                if (\is_string($key) && \is_scalar($value)) {
                    $values[$key] = (string) $value;
                    $generated = array_values(array_diff($generated, [$key]));
                }
            }
        }
        foreach ($env as $key => $value) {
            if ($value !== '') {
                $values[$key] = $value;
                $generated = array_values(array_diff($generated, [$key]));
            }
        }

        return new self($values, $generated);
    }

    /**
     * Process environment plus server variables: under Apache mod_php,
     * `SetEnv` values only show up in $_SERVER. `HTTP_*` entries are request
     * headers and are never taken (a client must not inject configuration).
     *
     * @return array<string, string>
     */
    private static function environment(): array
    {
        $env = getenv();
        foreach ($_SERVER as $key => $value) {
            if (\is_string($key) && \is_string($value) && !str_starts_with($key, 'HTTP_') && !isset($env[$key])) {
                $env[$key] = $value;
            }
        }

        return $env;
    }

    /** @param array<string, string> $values */
    public static function fromArray(array $values): self
    {
        return new self($values);
    }

    public function get(string $name, string $default = ''): string
    {
        $value = $this->values[$name] ?? '';

        return $value === '' ? $default : $value;
    }

    public function int(string $name, int $default): int
    {
        $value = $this->get($name);
        if ($value === '' || preg_match('/^\d+$/', $value) !== 1 || (int) $value <= 0) {
            return $default;
        }

        return (int) $value;
    }

    public function bool(string $name): bool
    {
        return $this->get($name) === '1';
    }

    /** The value was generated on the first start (SECRETS_FILE), not set by the operator. */
    public function isGenerated(string $name): bool
    {
        return \in_array($name, $this->generated, true);
    }

    public function version(): string
    {
        return $this->get('APP_VERSION', '0.0.0');
    }
}
