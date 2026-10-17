<?php

declare(strict_types=1);

// Adds the developers' provider test account from LIVE_MAIL_* (.env.live,
// see docs/product/mail-providers.md) to this instance: `make test-account`.
// Not part of an installation; prints only status and account id.

require __DIR__ . '/../vendor/autoload.php';

$config = Fma\Config::load();
$db = new Fma\Db\Database($config);
$logger = new Fma\Log\Logger('console', $config->get('LOG_LEVEL', 'info'));
$env = [];
foreach (['LIVE_MAIL_USER', 'LIVE_MAIL_PASSWORD', 'LIVE_IMAP_HOST', 'LIVE_IMAP_PORT', 'LIVE_SMTP_HOST', 'LIVE_SMTP_PORT'] as $name) {
    $env[$name] = (string) getenv($name);
}

try {
    $result = Fma\Install\TestAccount::add(
        $db,
        $config,
        new Fma\Mail\SocketConnectionTester($config, $logger),
        new Fma\Jobs\JobQueue($db, $config->int('IMAP_MAX_CONNECTIONS_PER_HOST', 4)),
        $env,
    );
} catch (RuntimeException $e) {
    fwrite(STDERR, "test account: {$e->getMessage()}\n");
    exit(1);
}
echo $result['status'] === 'added'
    ? "test account added ({$result['accountId']}), first sync queued\n"
    : "test account already present ({$result['accountId']})\n";
