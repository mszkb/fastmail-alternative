<?php

declare(strict_types=1);

namespace Fma;

/**
 * Configuration (ADR-0013): environment variables, or a `config.php`
 * outside the web root for hosters without environment variables. The
 * environment wins. Variables: docs/operations/configuration.md.
 *
 * `config.php` returns an array with the same names as the environment,
 * e.g. `return ['MASTER_KEY' => '...', 'DATABASE_URL' => 'mysql://...'];`.
 * Values are never logged.
 */
final class Config
{
    /** @param array<string, string> $values */
    private function __construct(private readonly array $values) {}

    /**
     * @param array<string, string>|null $env  defaults to getenv()
     * @param string|null                $file defaults to FMA_CONFIG or ../config.php
     */
    public static function load(?array $env = null, ?string $file = null): self
    {
        $env ??= self::environment();
        $file ??= ($env['FMA_CONFIG'] ?? '') !== '' ? $env['FMA_CONFIG'] : \dirname(__DIR__) . '/config.php';
        $values = [];
        if (is_file($file)) {
            $fromFile = require $file;
            if (!\is_array($fromFile)) {
                throw new \RuntimeException('config.php must return an array');
            }
            foreach ($fromFile as $key => $value) {
                if (\is_string($key) && \is_scalar($value)) {
                    $values[$key] = (string) $value;
                }
            }
        }
        foreach ($env as $key => $value) {
            if ($value !== '') {
                $values[$key] = $value;
            }
        }

        return new self($values);
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

    public function version(): string
    {
        return $this->get('APP_VERSION', '0.0.0');
    }
}
