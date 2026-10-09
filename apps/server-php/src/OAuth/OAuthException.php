<?php

declare(strict_types=1);

namespace Fma\OAuth;

/**
 * OAuth failure with a stable code: `invalid_grant` (refresh token revoked or
 * expired: the user has to sign in again), `invalid_client` (client id or
 * secret rejected: the operator has to fix the setup), `network`, `provider`
 * (any other error answer), `no_refresh_token`, `no_email`, `state`. Never carries
 * provider texts or tokens.
 */
final class OAuthException extends \RuntimeException
{
    public function __construct(public readonly string $errorCode)
    {
        parent::__construct($errorCode);
    }

    public function needsNewLogin(): bool
    {
        return \in_array($this->errorCode, ['invalid_grant', 'no_refresh_token'], true);
    }
}
