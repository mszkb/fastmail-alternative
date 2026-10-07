<?php

declare(strict_types=1);

// Cron entry point (ADR-0013): runs due jobs within a time budget.
// Crontab, e.g. every minute: * * * * * php /path/to/apps/server-php/bin/cron.php
// CRON_TIME_BUDGET_SECONDS (default 50) must stay below the host's limit.

require __DIR__ . '/../vendor/autoload.php';

$config = Fma\Config::load();
$result = Fma\Jobs\Bootstrap::runner($config, new Fma\Log\Logger('cron', $config->get('LOG_LEVEL', 'info')))
    ->runOnce((float) $config->int('CRON_TIME_BUDGET_SECONDS', 50));
exit(0);
