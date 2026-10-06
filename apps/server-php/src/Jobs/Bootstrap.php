<?php

declare(strict_types=1);

namespace Fma\Jobs;

use Fma\Config;
use Fma\Db\Database;
use Fma\Log\Logger;

/** Builds the runner with all job handlers ported so far. */
final class Bootstrap
{
    public static function runner(Config $config, Logger $logger, ?Database $db = null): Runner
    {
        $db ??= new Database($config);
        // Handlers are registered here as the job types get ported (#103-#107).
        return new Runner(
            $db,
            new JobQueue($db, $config->int('IMAP_MAX_CONNECTIONS_PER_HOST', 4)),
            new AccountHealth($db),
            $logger,
            $config,
        );
    }
}
