<?php

declare(strict_types=1);

// Applies pending database migrations: php bin/migrate.php

require __DIR__ . '/../vendor/autoload.php';

$config = Fma\Config::load();
$logger = new Fma\Log\Logger('migrate', $config->get('LOG_LEVEL', 'info'));
try {
    $applied = (new Fma\Db\Migrator(Fma\Db\Database::connect($config), __DIR__ . '/../migrations'))->migrate();
    $logger->info('migrations applied', ['count' => count($applied), 'names' => $applied]);
} catch (Throwable $e) {
    // No message: driver errors may contain connection details.
    $logger->error('migration failed', ['errName' => $e::class, 'errCode' => $e->getCode()]);
    exit(1);
}
