<?php

declare(strict_types=1);

namespace Fma\Mail;

/** IMAP or SMTP server of an account with its login (never logged). */
final class HostConfig
{
    public function __construct(
        public readonly string $host,
        public readonly int $port,
        public readonly bool $secure,
        public readonly string $user,
        #[\SensitiveParameter]
        public readonly string $password,
    ) {}
}
