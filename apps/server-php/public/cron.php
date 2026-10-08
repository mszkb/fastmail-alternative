<?php

declare(strict_types=1);

// Web cron for hosts that only offer "call this URL" (ADR-0013):
// POST or GET /cron.php with header `Authorization: Bearer <CRON_TOKEN>`
// (or ?token=... for cron services without custom headers).
// Disabled (404) unless CRON_TOKEN is set.

header_remove('X-Powered-By');

require __DIR__ . '/../vendor/autoload.php';

$config = Fma\Config::load();
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
$expected = $config->get('CRON_TOKEN');
if ($expected === '') {
    http_response_code(404);
    echo '{"message":"Not found"}';
    exit;
}
$auth = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
$given = is_string($auth) && str_starts_with($auth, 'Bearer ') ? substr($auth, 7) : ($_GET['token'] ?? '');
if (!is_string($given) || !hash_equals(hash('sha256', $expected), hash('sha256', $given))) {
    http_response_code(401);
    echo '{"message":"Invalid cron token"}';
    exit;
}
ignore_user_abort(true);
$logger = new Fma\Log\Logger('cron', $config->get('LOG_LEVEL', 'info'));
try {
    $runner = Fma\Jobs\Bootstrap::runner($config, $logger);
} catch (Fma\Db\SchemaTooNewException $e) {
    $logger->error('jobs refused: the database was migrated by a newer version; upgrade again or roll back with a restore', ['unknown' => $e->unknown]);
    http_response_code(503);
    echo '{"message":"Database schema is newer than this version"}';
    exit;
}
$result = $runner->runOnce((float) $config->int('CRON_TIME_BUDGET_SECONDS', 50));
echo json_encode($result);
