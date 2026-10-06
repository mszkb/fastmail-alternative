<?php

declare(strict_types=1);

// Optional long-running worker (ADR-0013) for VPS/Docker, instead of cron:
// runs the job loop continuously and writes a heartbeat file
// (WORKER_HEARTBEAT_FILE, default /tmp/worker-heartbeat) after each pass.
// Holds the runner lock while working, so a cron call at the same time
// returns at once. With IMAP_IDLE (default on) it also keeps one IDLE
// connection per account on the INBOX (Fma\Jobs\IdleManager): PHP is
// single-threaded, so short runner passes alternate with stream_select
// over all IDLE sockets.

require __DIR__ . '/../vendor/autoload.php';

$config = Fma\Config::load();
$logger = new Fma\Log\Logger('worker', $config->get('LOG_LEVEL', 'info'));
$db = new Fma\Db\Database($config);
$runner = Fma\Jobs\Bootstrap::runner($config, $logger, $db);
$idle = Fma\Jobs\IdleManager::enabled($config)
    ? new Fma\Jobs\IdleManager($db, new Fma\Jobs\JobQueue($db), $config, $logger)
    : null;
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
$logger->info('worker started', ['imapIdle' => $idle !== null]);
while (!$stop) {
    try {
        // Short budget with IDLE, so notifications are not left waiting long.
        $result = $runner->runOnce($idle !== null ? 10.0 : 30.0);
        @file_put_contents($heartbeat, (string) time());
        $wait = $result['done'] + $result['failed'] === 0 ? 2.0 : 0.0;
        if ($idle !== null) {
            $idle->poll($wait);
        } elseif ($wait > 0) {
            sleep(2);
        }
    } catch (Throwable $e) {
        $logger->error('worker loop failed', ['errName' => $e::class]);
        sleep(5);
    }
}
$idle?->stop();
