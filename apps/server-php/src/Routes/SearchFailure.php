<?php

declare(strict_types=1);

namespace Fma\Routes;

/** Search failure with a stable code (no provider text: it may echo the query). */
final class SearchFailure extends \RuntimeException
{
    public function __construct(public readonly string $errorCode, public readonly int $status, string $message)
    {
        parent::__construct($message);
    }
}
