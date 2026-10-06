<?php

declare(strict_types=1);

namespace Fma\Mail;

/**
 * Failure while talking to a mail server, with a stable code:
 * PORT_NOT_ALLOWED, PRIVATE_HOST_BLOCKED, ENOTFOUND, ECONNREFUSED, ETIMEDOUT,
 * ETLS, TLS_REQUIRED, AUTH_FAILED, PROTOCOL. The message never contains
 * server responses (they may quote content or internal banners).
 */
final class MailException extends \RuntimeException
{
    public function __construct(public readonly string $errorCode, string $message = '', ?\Throwable $previous = null)
    {
        parent::__construct($message !== '' ? $message : $errorCode, 0, $previous);
    }
}
