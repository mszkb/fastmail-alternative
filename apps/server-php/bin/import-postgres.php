<?php

declare(strict_types=1);

// One-time move of an existing installation (Node + PostgreSQL) into the
// configured MySQL/MariaDB database (#108). Run bin/migrate.php first; the
// target must be empty. Needs ext-pdo_pgsql and the same MASTER_KEY.
// Usage: php bin/import-postgres.php postgres://user:pass@host:5432/mail
// Copy the mail-data volume (raw mails) separately, unchanged.

require __DIR__ . '/../vendor/autoload.php';

$url = $argv[1] ?? '';
if ($url === '') {
    fwrite(STDERR, "Usage: php bin/import-postgres.php postgres://user:pass@host:5432/mail\n");
    exit(2);
}
$config = Fma\Config::load();
$logger = new Fma\Log\Logger('import', $config->get('LOG_LEVEL', 'info'));
try {
    $mysql = Fma\Db\Database::connect($config);
    $counts = (new Fma\Migration\PostgresImporter(Fma\Migration\PostgresImporter::connectPostgres($url), $mysql, $logger))->import();
    $logger->info('import finished', ['rows' => $counts]);
    if ($config->get('MASTER_KEY') !== '') {
        $check = Fma\Migration\ReadabilityCheck::run($mysql, $config->get('MASTER_KEY'));
        $logger->info('readability check', $check);
        if ($check['unreadable'] > 0) {
            $logger->error('some data cannot be decrypted: wrong MASTER_KEY?', $check);
            exit(1);
        }
    }
} catch (Throwable $e) {
    // No message: driver errors may contain connection details.
    $logger->error('import failed', ['errName' => $e::class, 'errCode' => $e->getCode()]);
    exit(1);
}
