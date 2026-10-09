<?php

declare(strict_types=1);

namespace Fma\Jobs;

/**
 * A connection-level failure of a mail account with a stable code
 * (AUTH_FAILED, TIMEOUT, ...). Only the code is stored and logged, never a
 * server message (it may quote content).
 */
final class AccountErrorException extends \RuntimeException
{
    /** OAUTH_EXPIRED: the grant was revoked or expired, the user has to sign in again. */
    private const AUTH_CODES = ['AUTH_FAILED', 'CREDENTIALS_REQUIRED', 'OAUTH_EXPIRED', 'OAUTH_NOT_CONFIGURED'];

    public function __construct(public readonly string $errorCode, ?\Throwable $previous = null)
    {
        parent::__construct($errorCode, 0, $previous);
    }

    /** 'auth' (no automatic retry) or 'unreachable' (backoff). */
    public function kind(): string
    {
        return \in_array($this->errorCode, self::AUTH_CODES, true) ? 'auth' : 'unreachable';
    }
}
