<?php

declare(strict_types=1);

// Front controller for /api/* (Apache via .htaccess, nginx/Caddy via
// try_files, or `php -S 127.0.0.1:3001 -t public public/index.php`).

// Do not advertise the PHP version.
header_remove('X-Powered-By');

require __DIR__ . '/../vendor/autoload.php';

Fma\App::create(Fma\Config::load())->run();
