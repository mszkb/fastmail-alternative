<?php

declare(strict_types=1);

// Prints a new first-run setup code (replaces a previously generated one).
// For hosts where the PHP error log is hard to reach. Without effect once
// the user exists; a configured SETUP_TOKEN takes precedence.

require __DIR__ . '/../vendor/autoload.php';

$config = Fma\Config::load();
$db = new Fma\Db\Database($config);
if (Fma\Db\Database::run($db->pdo(), 'SELECT EXISTS (SELECT 1 FROM `user`)')->fetchColumn() == 1) {
    fwrite(STDERR, "Setup is already completed.\n");
    exit(1);
}
if (trim($config->get('SETUP_TOKEN')) !== '') {
    fwrite(STDERR, "SETUP_TOKEN is configured: use that value.\n");
    exit(1);
}
$code = (new Fma\Auth\SetupCode($config, $db, new Fma\Log\Logger('setup')))->regenerate();
echo "Setup code: {$code}\n";
