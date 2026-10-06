<?php

declare(strict_types=1);

// Installation check (#109): php bin/check.php [--no-network]
// Exit code 0 when every required check passed.

require __DIR__ . '/../vendor/autoload.php';

$checks = (new Fma\Install\SystemCheck(Fma\Config::load()))->run(!in_array('--no-network', $argv, true));
foreach ($checks as $check) {
    printf("%s %s%s\n", $check['ok'] ? '[ok]  ' : ($check['required'] ? '[FAIL]' : '[warn]'), $check['name'], $check['detail'] !== '' ? " - {$check['detail']}" : '');
}
exit(Fma\Install\SystemCheck::passed($checks) ? 0 : 1);
