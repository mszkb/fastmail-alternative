<?php

declare(strict_types=1);

// Optional long-running worker (ADR-0013) for VPS/Docker, instead of cron:
// runs the job loop continuously and writes a heartbeat file
// (WORKER_HEARTBEAT_FILE, default /tmp/worker-heartbeat) after each pass.
// Holds the runner lock while working, so a cron call at the same time
// returns at once. IMAP IDLE follows with the mail sync port (#103).

require __DIR__ . '/../vendor/autoload.php';

$config = Fma\Config::load();
$logger = new Fma\Log\Logger('worker', $config->get('LOG_LEVEL', 'info'));
$runner = Fma\Jobs\Bootstrap::runner($config, $logger);
$heartbeat = $config->get('WORKER_HEARTBEAT_FILE', '/tmp/worker-heartbeat');
$stop = false;
if (function_exists('pcntl_async_signals')) {
    pcntl_async_signals(true);
    foreach ([SIGINT, SIGTERM] as $signal) {
        pcntl_signal($signal, static function () use (&$stop, $logger): void {
            $logger->info('shutting down after the running job');
            $stop = true;
        });
    }
}
$logger->info('worker started');
while (!$stop) {
    try {
        $result = $runner->runOnce(30.0);
        @file_put_contents($heartbeat, (string) time());
        if ($result['done'] + $result['failed'] === 0) {
            sleep(2);
        }
    } catch (Throwable $e) {
        $logger->error('worker loop failed', ['errName' => $e::class]);
        sleep(5);
    }
}
