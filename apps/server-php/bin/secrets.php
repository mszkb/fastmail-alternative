<?php

declare(strict_types=1);

// Secrets generated on the first docker start (#164, ADR-0016).
//   php bin/secrets.php init     the one-shot `secrets` service (as root):
//                                creates what .env does not set, in SECRETS_DIR
//   php bin/secrets.php export   prints the generated values as .env lines,
//                                to back them up (MASTER_KEY!) or move them to .env
// Logs only names and paths, never values.

use Fma\Install\GeneratedSecrets;
use Fma\Log\Logger;

require __DIR__ . '/../vendor/autoload.php';

$command = $argv[1] ?? '';
$dir = getenv('SECRETS_DIR') ?: '/data/secrets';

if ($command === 'init') {
    $env = getenv();
    $owner = null;
    if (function_exists('posix_getuid') && posix_getuid() === 0) {
        $user = posix_getpwnam('www-data');
        if ($user === false) {
            fwrite(STDERR, "user www-data not found\n");
            exit(1);
        }
        $owner = [$user['uid'], $user['gid']];
    }
    $generated = GeneratedSecrets::ensure($dir, $env, $owner);
    $logger = new Logger('secrets');
    $stored = GeneratedSecrets::load($dir . '/' . GeneratedSecrets::FILE);
    if (($env['MASTER_KEY'] ?? '') !== '' && isset($stored['MASTER_KEY']) && !hash_equals($stored['MASTER_KEY'], $env['MASTER_KEY'])) {
        // .env wins; data encrypted with the generated key is unreadable with the other one.
        $logger->warn(
            'MASTER_KEY in .env differs from the generated one in ' . GeneratedSecrets::FILE
            . ': the .env value is used - data encrypted before is unreadable with it',
            ['event' => 'secrets.master_key_mismatch'],
        );
    }
    if ($generated === []) {
        $logger->info('secrets ready, nothing generated', ['event' => 'secrets.ready']);
        exit(0);
    }
    $logger->info('generated missing secrets', ['event' => 'secrets.generated', 'names' => $generated, 'file' => $dir . '/' . GeneratedSecrets::FILE]);
    if (in_array('MASTER_KEY', $generated, true)) {
        $logger->warn(
            'a new MASTER_KEY was generated: back it up separately from the database backups, '
            . 'e.g. `docker compose exec php php bin/secrets.php export` - without it all mails and credentials are lost',
            ['event' => 'secrets.backup_master_key'],
        );
    }
    exit(0);
}

if ($command === 'export') {
    $values = GeneratedSecrets::load(getenv('SECRETS_FILE') ?: $dir . '/' . GeneratedSecrets::FILE);
    if ($values === []) {
        fwrite(STDERR, "No generated secrets (all values come from .env or config.php).\n");
        exit(1);
    }
    echo "# Generated secrets (#164). Keep them safe and separate from database backups.\n";
    echo "# To pin them in .env, DB_PASSWORD becomes MARIADB_PASSWORD.\n";
    foreach ($values as $name => $value) {
        echo ($name === 'DB_PASSWORD' ? 'MARIADB_PASSWORD' : $name) . '=' . $value . "\n";
    }
    exit(0);
}

fwrite(STDERR, "usage: php bin/secrets.php init | export\n");
exit(2);
