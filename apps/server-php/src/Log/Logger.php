<?php

declare(strict_types=1);

namespace Fma\Log;

/**
 * Structured JSON logging, one line per entry (pino-compatible fields:
 * level, time, service, msg). Sensitive keys are censored recursively
 * (same list as SENSITIVE_LOG_KEYS in packages/shared/src/redact.ts):
 * no credentials, tokens or mail contents in logs (principle 6).
 */
final class Logger
{
    public const SENSITIVE_KEYS = [
        // Credentials and tokens
        'password', 'pass', 'token', 'access_token', 'refresh_token', 'id_token', 'client_secret',
        'secret', 'authorization', 'cookie', 'set-cookie', 'credentials', 'master_key', 'vapid_private_key',
        // Mail content: everything a human reads (data model "Verschlüsselung")
        'subject', 'snippet', 'preview', 'body', 'html', 'text', 'address', 'addresses',
        // PHP-only additions (also readable content)
        'recipients', 'filename',
    ];

    private const LEVELS = ['debug' => 20, 'info' => 30, 'warn' => 40, 'error' => 50];
    private const CENSOR = '[REDACTED]';
    private const MAX_DEPTH = 10;

    private readonly int $minLevel;

    /** @var resource */
    private $stream;

    /** @param resource|null $stream defaults to stderr */
    public function __construct(private readonly string $service, string $level = 'info', $stream = null)
    {
        $this->minLevel = self::LEVELS[$level] ?? self::LEVELS['info'];
        $this->stream = $stream ?? fopen('php://stderr', 'wb') ?: STDERR;
    }

    /** @param array<string, mixed> $fields */
    public function debug(string $msg, array $fields = []): void
    {
        $this->log('debug', $msg, $fields);
    }

    /** @param array<string, mixed> $fields */
    public function info(string $msg, array $fields = []): void
    {
        $this->log('info', $msg, $fields);
    }

    /** @param array<string, mixed> $fields */
    public function warn(string $msg, array $fields = []): void
    {
        $this->log('warn', $msg, $fields);
    }

    /** @param array<string, mixed> $fields */
    public function error(string $msg, array $fields = []): void
    {
        $this->log('error', $msg, $fields);
    }

    /** @param array<string, mixed> $fields */
    private function log(string $level, string $msg, array $fields): void
    {
        $num = self::LEVELS[$level];
        if ($num < $this->minLevel) {
            return;
        }
        $entry = ['level' => $num, 'time' => (int) floor(microtime(true) * 1000), 'service' => $this->service]
            + self::redact($fields) + ['msg' => $msg];
        $line = json_encode($entry, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE | JSON_PARTIAL_OUTPUT_ON_ERROR);
        fwrite($this->stream, $line . "\n");
    }

    /**
     * @param array<mixed> $value
     *
     * @return array<mixed>
     */
    public static function redact(array $value, int $depth = 0): array
    {
        $out = [];
        foreach ($value as $key => $item) {
            if (\is_string($key) && \in_array(strtolower($key), self::SENSITIVE_KEYS, true)) {
                $out[$key] = self::CENSOR;
            } elseif (\is_array($item)) {
                $out[$key] = $depth >= self::MAX_DEPTH ? self::CENSOR : self::redact($item, $depth + 1);
            } elseif (\is_object($item)) {
                $out[$key] = self::CENSOR;
            } else {
                $out[$key] = $item;
            }
        }

        return $out;
    }
}
