<?php

declare(strict_types=1);

namespace Fma\Mail;

/**
 * IMAP or SMTP server of an account with its login (never logged). With an
 * OAuth access token the login is XOAUTH2 instead of the password.
 */
final class HostConfig
{
    public function __construct(
        public readonly string $host,
        public readonly int $port,
        public readonly bool $secure,
        public readonly string $user,
        #[\SensitiveParameter]
        public readonly string $password,
        #[\SensitiveParameter]
        public readonly ?string $oauthToken = null,
    ) {}

    /** SASL XOAUTH2 initial response (Google and Microsoft), base64. */
    public function xoauth2(): string
    {
        return base64_encode("user={$this->user}\x01auth=Bearer {$this->oauthToken}\x01\x01");
    }
}
