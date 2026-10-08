<?php

declare(strict_types=1);

// Cron entry point (ADR-0013): runs due jobs within a time budget.
// Crontab, e.g. every minute: * * * * * php /path/to/apps/server-php/bin/cron.php
// CRON_TIME_BUDGET_SECONDS (default 50) must stay below the host's limit.

require __DIR__ . '/../vendor/autoload.php';

$config = Fma\Config::load();
$logger = new Fma\Log\Logger('cron', $config->get('LOG_LEVEL', 'info'));
try {
    $runner = Fma\Jobs\Bootstrap::runner($config, $logger);
} catch (Fma\Db\SchemaTooNewException $e) {
    $logger->error('jobs refused: the database was migrated by a newer version; upgrade again or roll back with a restore', ['unknown' => $e->unknown]);
    exit(1);
}
$result = $runner->runOnce((float) $config->int('CRON_TIME_BUDGET_SECONDS', 50));
exit(0);
