<?php

declare(strict_types=1);

namespace Fma\Auth;

/** An authenticated session (request attribute `auth`). */
final class Session
{
    public function __construct(
        public readonly string $sessionId,
        public readonly string $deviceId,
        public readonly string $userId,
        public readonly string $email,
        public readonly \DateTimeImmutable $tokenIssuedAt,
        /** Sessions::COOKIE or Sessions::BEARER */
        public readonly string $kind = Sessions::COOKIE,
    ) {}

    public function isBearer(): bool
    {
        return $this->kind === Sessions::BEARER;
    }
}
