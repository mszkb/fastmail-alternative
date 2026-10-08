<?php

declare(strict_types=1);

// Applies pending database migrations: php bin/migrate.php

require __DIR__ . '/../vendor/autoload.php';

$config = Fma\Config::load();
$logger = new Fma\Log\Logger('migrate', $config->get('LOG_LEVEL', 'info'));
try {
    $applied = (new Fma\Db\Migrator(Fma\Db\Database::connect($config), __DIR__ . '/../migrations'))->migrate();
    $logger->info('migrations applied', ['count' => count($applied), 'names' => $applied]);
} catch (Fma\Db\SchemaTooNewException $e) {
    // Only migration names: safe to log. Refuse to start on a newer schema.
    $logger->error('migration refused: the database was migrated by a newer version; upgrade again or roll back with a restore', ['unknown' => $e->unknown]);
    exit(1);
} catch (Throwable $e) {
    // No message: driver errors may contain connection details.
    $logger->error('migration failed', ['errName' => $e::class, 'errCode' => $e->getCode()]);
    exit(1);
}
