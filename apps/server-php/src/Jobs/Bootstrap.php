<?php

declare(strict_types=1);

namespace Fma\Jobs;

use Fma\Config;
use Fma\Db\Database;
use Fma\Log\Logger;
use Fma\Push\PushNotifyHandler;

/** Builds the runner with all job handlers ported so far. */
final class Bootstrap
{
    public static function runner(Config $config, Logger $logger, ?Database $db = null): Runner
    {
        $db ??= new Database($config);
        $queue = new JobQueue($db, $config->int('IMAP_MAX_CONNECTIONS_PER_HOST', 4));
        $runner = new Runner($db, $queue, new AccountHealth($db), $logger, $config);
        // Handlers are registered here as the job types get ported (#103-#107).
        $runner->register('folder_sync', new FolderSyncJob($db, $config, $queue));
        $runner->register('push_notify', PushNotifyHandler::fromConfig($db, $config, $logger));
        $files = \Fma\Mail\FileStore::fromConfig($config);
        $runner->register('cleanup', new CleanupJob($db, $files, $logger, $config));
        $runner->register('account_cleanup', new AccountCleanupJob($db, $queue, $files));
        $runner->register('message_action', new MessageActionJob($db, $config, $queue, $files, $logger));
        $runner->register('message_sync', new MessageSyncJob($db, $config, $queue, $files, $logger));
        $runner->register('send_message', new SendMessageJob($db, $config, $queue, $logger));
        $runner->register('draft_sync', new DraftSyncJob($db, $config, $queue));

        return $runner;
    }
}
