<?php

declare(strict_types=1);

namespace Fma\Jobs;

/**
 * Thrown by a handler that stopped because its job was asked to cancel
 * (#119). The runner ends the job as 'cancelled' instead of retrying it.
 */
final class JobCancelledException extends \RuntimeException
{
    public function __construct()
    {
        parent::__construct('job cancelled');
    }
}
