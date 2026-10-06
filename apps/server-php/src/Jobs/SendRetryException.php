<?php

declare(strict_types=1);

namespace Fma\Jobs;

/** Transient send_message failure with a stable code; the job queue retries with backoff. */
final class SendRetryException extends \RuntimeException
{
    public function __construct(public readonly string $errorCode, ?\Throwable $previous = null)
    {
        parent::__construct("send_message retry: {$errorCode}", 0, $previous);
    }
}
