<?php

declare(strict_types=1);

namespace Fma\Jobs;

interface JobHandler
{
    /**
     * Runs the job; throwing fails it (retry with backoff). Reports account
     * health via the outcome: true = the provider was reached (closes the
     * circuit), false = nothing to report.
     */
    public function run(Job $job, Deadline $deadline): bool;
}
