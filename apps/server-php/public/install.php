<?php

declare(strict_types=1);

// Web installer for webspace without shell access (#109): system check,
// config.php suggestion, migrations and the first-run setup code.
// Answers 404 once the first user exists. See docs/operations/installation-php.md.

header_remove('X-Powered-By');

require __DIR__ . '/../vendor/autoload.php';

// Same lookup as Fma\Config::load(): FMA_CONFIG (environment or SetEnv), else ../config.php.
$configFile = getenv('FMA_CONFIG') ?: ($_SERVER['FMA_CONFIG'] ?? '');
$configFile = is_string($configFile) && $configFile !== '' ? $configFile : dirname(__DIR__) . '/config.php';
$config = Fma\Config::load();
$installer = new Fma\Install\Installer($config, new Fma\Db\Database($config), dirname(__DIR__) . '/migrations', $configFile);
$response = $installer->handle(Slim\Psr7\Factory\ServerRequestFactory::createFromGlobals());

http_response_code($response->getStatusCode());
foreach ($response->getHeaders() as $name => $values) {
    header($name . ': ' . implode(', ', $values));
}
echo $response->getBody();
