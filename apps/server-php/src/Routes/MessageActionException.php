<?php

declare(strict_types=1);

namespace Fma\Routes;

/** Expected failure of a message action, answered with its status and German message. */
final class MessageActionException extends \RuntimeException
{
    public function __construct(public readonly int $statusCode, string $message)
    {
        parent::__construct($message);
    }
}
