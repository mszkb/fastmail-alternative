<?php

declare(strict_types=1);

namespace Fma\Mail;

/**
 * Result of a connection test. `message` is a fixed German text per
 * code, never a server response.
 */
final class TestResult
{
    /** @param list<string> $capabilities IMAP capabilities on success */
    public function __construct(
        public readonly bool $ok,
        public readonly ?string $code = null,
        public readonly ?string $message = null,
        public readonly array $capabilities = [],
    ) {}

    /** JSON shape of the API ({ok, code?, message?, capabilities?}). */
    /** @return array<string, mixed> */
    public function toArray(): array
    {
        return array_filter(
            ['ok' => $this->ok, 'code' => $this->code, 'message' => $this->message, 'capabilities' => $this->ok && $this->capabilities !== [] ? $this->capabilities : null],
            static fn(mixed $v): bool => $v !== null,
        );
    }
}
