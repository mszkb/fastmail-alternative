<?php

declare(strict_types=1);

namespace Fma\Jobs;

/**
 * Time budget of a cron run (ADR-0013). Handlers with long work (e.g. a
 * first message sync) check it between batches and stop early; the rest
 * runs in the next cron call.
 */
final class Deadline
{
    private readonly float $end;

    public function __construct(float $seconds)
    {
        $this->end = microtime(true) + $seconds;
    }

    public function remaining(): float
    {
        return max(0.0, $this->end - microtime(true));
    }

    public function expired(): bool
    {
        return $this->remaining() <= 0.0;
    }
}
