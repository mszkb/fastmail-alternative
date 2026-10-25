<?php

declare(strict_types=1);

namespace Fma\OAuth;

/** Tokens of one grant; never logged. */
final class TokenSet
{
    public function __construct(
        #[\SensitiveParameter]
        public readonly string $accessToken,
        #[\SensitiveParameter]
        public readonly ?string $refreshToken,
        public readonly int $expiresAt,
        public readonly ?string $email,
    ) {}
}
