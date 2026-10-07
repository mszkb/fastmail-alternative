<?php

declare(strict_types=1);

namespace Fma\Jobs;

use Fma\Db\Database;
use Fma\Mail\FileStore;

/**
 * `account_cleanup` job like apps/worker/src/jobs/account-cleanup.ts
 * (roadmap 3.1): removes the encrypted files of a deleted account.
 *
 * The account row (and with it every database row and the DEK) is already
 * gone; the payload carries only the id (job.account_id stays NULL, it
 * would cascade-delete the job). A job of the account that was already
 * running may still write a file, so the job re-enqueues itself once for a
 * delayed second pass.
 */
final class AccountCleanupJob implements JobHandler
{
    /** Delay of the second pass; longer than any job may run. */
    public const SECOND_PASS_DELAY_SECONDS = 65 * 60;

    public function __construct(
        private readonly Database $db,
        private readonly JobQueue $queue,
        private readonly FileStore $files,
    ) {}

    public function run(Job $job, Deadline $deadline): bool
    {
        $this->cleanup($job->payload);

        return false;
    }

    /**
     * @param array<string, mixed> $payload
     *
     * @return 'removed'|'account_exists'|'invalid'
     */
    public function cleanup(array $payload): string
    {
        $accountId = \is_string($payload['accountId'] ?? null) ? strtolower($payload['accountId']) : '';
        // Strict id check: the id becomes a path segment.
        if (!FileStore::isId($accountId)) {
            return 'invalid';
        }
        // Never touch the files of an existing account.
        if (Database::run($this->db->pdo(), 'SELECT 1 FROM mail_account WHERE id = ?', [$accountId])->fetchColumn() !== false) {
            return 'account_exists';
        }
        $this->files->removeAccountDir($accountId);

        if (($payload['pass'] ?? null) !== 2) {
            $this->queue->enqueue('account_cleanup', null, ['accountId' => $accountId, 'pass' => 2], self::SECOND_PASS_DELAY_SECONDS);
        }

        return 'removed';
    }
}
