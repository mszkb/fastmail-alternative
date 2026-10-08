<?php

declare(strict_types=1);

namespace Fma\Jobs;

use Fma\Config;
use Fma\Db\Database;
use Fma\Log\Logger;

/**
 * Runs jobs within a time budget (ADR-0013): the entry point of
 * `bin/cron.php`, `public/cron.php` and the loop of `bin/worker.php`.
 *
 * - One runner at a time (GET_LOCK 'fma-runner'): a second cron call while
 *   one is running returns at once. Jobs run one after another, so there
 *   is never more than one running job (and IMAP connection) per account.
 * - Before claiming: lost 'running' jobs are re-queued, due folder_syncs
 *   and the cleanup job are enqueued (scheduler).
 * - Priority types (message_action, send_message, draft_sync) first.
 * - Only types with a registered handler are claimed; jobs of unknown
 *   types stay queued.
 * - A new job starts only while enough budget is left; handlers check the
 *   Deadline for long work.
 * - Cancellation (#119): a handler that stopped on a cancel request throws
 *   JobCancelledException; the job ends as 'cancelled', is not retried and
 *   does not count as an account failure. Works the same for cron and the
 *   long-running worker, both run jobs through here.
 */
final class Runner
{
    public const LOCK = 'fma-runner';
    public const PRIORITY_TYPES = ['message_action', 'send_message', 'draft_sync'];
    /** Hard timeout per type (seconds); used to detect lost jobs. */
    public const TIMEOUTS = [
        'folder_sync' => 180, 'message_sync' => 900, 'message_action' => 180, 'send_message' => 300,
        'draft_sync' => 120, 'account_cleanup' => 300, 'push_notify' => 120, 'cleanup' => 600,
    ];
    /** A job 'running' longer than this is lost (longer than every timeout). */
    private const STALE_SECONDS = 1800;
    /** No new job when less budget is left. */
    private const MIN_BUDGET_SECONDS = 5.0;

    /** @var array<string, JobHandler> */
    private array $handlers = [];

    public function __construct(
        private readonly Database $db,
        private readonly JobQueue $queue,
        private readonly AccountHealth $health,
        private readonly Logger $logger,
        private readonly Config $config,
    ) {}

    public function register(string $type, JobHandler $handler): void
    {
        $this->handlers[$type] = $handler;
    }

    /**
     * One run: lock, schedule, work until the budget or the queue ends.
     *
     * @return array{locked: bool, done: int, failed: int}
     */
    public function runOnce(float $budgetSeconds): array
    {
        $pdo = $this->db->pdo();
        if ((int) Database::run($pdo, 'SELECT GET_LOCK(?, 0)', [self::LOCK])->fetchColumn() !== 1) {
            return ['locked' => false, 'done' => 0, 'failed' => 0];
        }
        try {
            $deadline = new Deadline($budgetSeconds);
            $this->schedule();

            return ['locked' => true] + $this->work($deadline);
        } finally {
            Database::run($pdo, 'SELECT RELEASE_LOCK(?)', [self::LOCK]);
        }
    }

    /** Scheduler tick: lost jobs, due syncs, periodic cleanup. */
    public function schedule(): void
    {
        foreach ($this->queue->requeueStale(self::STALE_SECONDS) as $job) {
            $this->logger->warn('lost job given up', ['jobId' => $job->id, 'type' => $job->type]);
        }
        if (isset($this->handlers['folder_sync'])) {
            $this->queue->enqueueDueSyncs($this->config->int('SYNC_INTERVAL_SECONDS', 120));
        }
        if (isset($this->handlers['cleanup'])) {
            $this->queue->enqueueDueCleanup($this->config->int('CLEANUP_INTERVAL_HOURS', 6) * 3600);
        }
    }

    /** @return array{done: int, failed: int} */
    public function work(Deadline $deadline): array
    {
        $types = array_keys($this->handlers);
        $priority = array_values(array_intersect(self::PRIORITY_TYPES, $types));
        $done = 0;
        $failed = 0;
        while ($deadline->remaining() >= self::MIN_BUDGET_SECONDS) {
            $job = $this->queue->claimNext($priority) ?? $this->queue->claimNext($types);
            if ($job === null) {
                break;
            }
            $this->execute($job, $deadline) ? ++$done : ++$failed;
        }

        return ['done' => $done, 'failed' => $failed];
    }

    private function execute(Job $job, Deadline $deadline): bool
    {
        $context = ['jobId' => $job->id, 'type' => $job->type, 'accountId' => $job->accountId, 'attempts' => $job->attempts];
        $this->logger->info('job started', $context);
        try {
            $reached = $this->handlers[$job->type]->run($job, $deadline);
            $this->queue->complete($job->id);
            if ($reached && $job->accountId !== null) {
                $this->health->recordSuccess($job->accountId);
            }
            $this->logger->info('job done', $context);

            return true;
        } catch (JobCancelledException) {
            $this->queue->markCancelled($job->id);
            $this->logger->info('job cancelled', $context);

            return true;
        } catch (\Throwable $e) {
            $code = $e instanceof AccountErrorException ? $e->errorCode : null;
            // Only class and code: messages may echo provider responses (principle 6).
            $this->queue->fail($job, implode(':', array_filter([$e::class, $code])));
            if ($e instanceof AccountErrorException && $job->accountId !== null) {
                $state = $this->health->recordFailure($job->accountId, $e);
                $this->logger->warn('account connection failed', $context + ['code' => $code] + ($state ?? []));
            }
            $this->logger->warn('job failed', $context + ['errName' => $e::class, 'errCode' => $code]);

            return false;
        }
    }
}
