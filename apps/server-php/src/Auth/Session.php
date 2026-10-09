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
        /** A native app token (Authorization: Bearer) instead of a browser cookie. */
        public readonly bool $native = false,
    ) {}
}
