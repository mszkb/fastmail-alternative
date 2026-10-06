<?php

declare(strict_types=1);

namespace Fma\Tests\Integration;

use Fma\Config;
use Fma\Db\Database;
use Fma\Db\Uuid;
use Fma\Jobs\AccountErrorException;
use Fma\Jobs\AccountHealth;
use Fma\Jobs\Deadline;
use Fma\Jobs\Job;
use Fma\Jobs\JobHandler;
use Fma\Jobs\JobQueue;
use Fma\Jobs\Runner;
use Fma\Log\Logger;
use Fma\Tests\Support\Http;

/** Port of apps/worker/test/scheduler.test.ts and account-isolation.test.ts. */
final class JobsTest extends DatabaseTestCase
{
    private \PDO $pdo;
    private JobQueue $queue;
    private string $userId;

    protected function setUp(): void
    {
        $this->pdo = self::$db->pdo();
        $this->pdo->exec('DELETE FROM job');
        $this->pdo->exec('DELETE FROM `user`');
        $this->queue = new JobQueue(self::$db, 2);
        $this->userId = Uuid::v4();
        Database::run($this->pdo, 'INSERT INTO `user` (id, email, password_hash) VALUES (?, ?, ?)', [$this->userId, 'jobs@example.org', 'x']);
    }

    /** @param list<mixed> $params */
    private function sql(string $sql, array $params = []): \PDOStatement
    {
        return Database::run($this->pdo, $sql, $params);
    }

    private function account(string $host = 'imap.example.org', string $status = 'ok'): string
    {
        $id = Uuid::v4();
        $this->sql(
            'INSERT INTO mail_account (id, user_id, display_name, email_address, imap_host, imap_port, smtp_host,
               smtp_port, wrapped_dek, key_id, credential_enc, status) VALUES (?, ?, ?, ?, ?, 993, ?, 465, ?, ?, ?, ?)',
            [$id, $this->userId, 'K', 'a@example.org', $host, 'smtp.example.org', 'w', 'v1', 'c', $status],
        );

        return $id;
    }

    private function runner(JobHandler ...$handlers): Runner
    {
        $runner = new Runner(self::$db, $this->queue, new AccountHealth(self::$db), new Logger('worker', 'error', Http::memoryStream()), Config::fromArray([]));
        foreach ($handlers as $type => $handler) {
            $runner->register((string) $type, $handler);
        }

        return $runner;
    }

    /** @param callable(Job): bool $fn */
    private static function handler(callable $fn): JobHandler
    {
        return new class ($fn) implements JobHandler {
            /** @param callable(Job): bool $fn */
            public function __construct(private $fn) {}

            public function run(Job $job, Deadline $deadline): bool
            {
                return ($this->fn)($job);
            }
        };
    }

    private function state(string $jobId): string
    {
        return (string) $this->sql('SELECT state FROM job WHERE id = ?', [$jobId])->fetchColumn();
    }

    public function testEnqueuesOneFolderSyncPerActiveAccountAndNoDuplicates(): void
    {
        $this->account();
        $this->account();
        $this->account(status: 'auth_error');
        $this->account(status: 'disabled');
        self::assertSame(2, $this->queue->enqueueDueSyncs(120));
        self::assertSame(0, $this->queue->enqueueDueSyncs(120));
    }

    public function testWaitsForTheIntervalAfterAFinishedSync(): void
    {
        $account = $this->account();
        $this->queue->enqueueDueSyncs(120);
        $this->sql("UPDATE job SET state = 'done'");
        self::assertSame(0, $this->queue->enqueueDueSyncs(120));
        $this->sql('UPDATE job SET created_at = UTC_TIMESTAMP(6) - INTERVAL 121 SECOND');
        self::assertSame(1, $this->queue->enqueueDueSyncs(120));
        self::assertSame(2, (int) $this->sql('SELECT COUNT(*) FROM job WHERE account_id = ?', [$account])->fetchColumn());
    }

    public function testDeduplicatesMessageSyncPerFolder(): void
    {
        $account = $this->account();
        self::assertTrue($this->queue->enqueueMessageSync($account, 'f1'));
        self::assertFalse($this->queue->enqueueMessageSync($account, 'f1'));
        self::assertTrue($this->queue->enqueueMessageSync($account, 'f2'));
    }

    public function testDebouncesMessageSyncAfterAFinishedOne(): void
    {
        $account = $this->account();
        $this->queue->enqueueMessageSync($account, 'f1');
        $this->sql("UPDATE job SET state = 'done', locked_at = UTC_TIMESTAMP(6)");
        $this->queue->enqueueMessageSync($account, 'f1', 30);
        $delay = (int) $this->sql("SELECT TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(6), run_at) FROM job WHERE state = 'queued'")->fetchColumn();
        self::assertGreaterThanOrEqual(28, $delay);
    }

    public function testRetriesWithBackoffAndFailsAfterFiveAttempts(): void
    {
        $account = $this->account();
        $id = $this->queue->enqueue('folder_sync', $account);
        $job = $this->queue->claimNext(['folder_sync']);
        self::assertNotNull($job);
        self::assertSame(1, $job->attempts);
        $this->queue->fail($job, 'X');
        $delay = (int) $this->sql('SELECT TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(6), run_at) FROM job WHERE id = ?', [$id])->fetchColumn();
        self::assertEqualsWithDelta(30, $delay, 2);
        self::assertSame('queued', $this->state($id));
        $this->queue->fail(new Job($id, 'folder_sync', $account, [], 5), 'X');
        self::assertSame('failed', $this->state($id));
    }

    public function testRequeuesStaleRunningJobsAndGivesUpExhaustedOnes(): void
    {
        $account = $this->account();
        $a = $this->queue->enqueue('folder_sync', $account);
        $b = $this->queue->enqueue('send_message', $this->account('other.example.org'));
        $this->sql("UPDATE job SET state = 'running', locked_at = UTC_TIMESTAMP(6) - INTERVAL 2 HOUR");
        $this->sql('UPDATE job SET attempts = 5 WHERE id = ?', [$b]);
        $givenUp = $this->queue->requeueStale(1800);
        self::assertSame('queued', $this->state($a));
        self::assertSame('failed', $this->state($b));
        self::assertCount(1, $givenUp);
        self::assertSame('send_message', $givenUp[0]->type);
        self::assertSame('WORKER_LOST', $this->sql('SELECT last_error FROM job WHERE id = ?', [$b])->fetchColumn());
    }

    public function testOneRunningJobPerAccountAndCircuitBreakerOnClaim(): void
    {
        $busy = $this->account();
        $this->queue->enqueue('message_sync', $busy);
        $this->queue->enqueue('message_sync', $busy);
        $backoff = $this->account('b.example.org');
        $this->sql('UPDATE mail_account SET next_retry_at = UTC_TIMESTAMP(6) + INTERVAL 1 HOUR WHERE id = ?', [$backoff]);
        $this->queue->enqueue('message_sync', $backoff);
        $this->queue->enqueue('message_sync', $this->account('c.example.org', 'auth_error'));
        $free = $this->queue->enqueue('cleanup');

        $first = $this->queue->claimNext(['message_sync', 'cleanup']);
        self::assertSame($busy, $first?->accountId);
        // The second job of $busy waits; the other accounts are blocked by the breaker.
        $second = $this->queue->claimNext(['message_sync', 'cleanup']);
        self::assertSame($free, $second?->id);
        self::assertNull($this->queue->claimNext(['message_sync', 'cleanup']));
    }

    public function testConnectionLimitPerImapHost(): void
    {
        foreach ([1, 2, 3] as $i) {
            $this->queue->enqueue('message_sync', $this->account('IMAP.shared.example'));
        }
        self::assertNotNull($this->queue->claimNext(['message_sync']));
        self::assertNotNull($this->queue->claimNext(['message_sync']));
        self::assertNull($this->queue->claimNext(['message_sync']), 'limit of 2 per host reached');
    }

    public function testParallelClaimsNeverTakeTheSameJob(): void
    {
        for ($i = 0; $i < 6; ++$i) {
            $this->queue->enqueue('cleanup');
        }
        $other = new Database(Config::fromArray(['DATABASE_URL' => self::$config->get('DATABASE_URL')]));
        $queues = [$this->queue, new JobQueue($other, 2)];
        $claimed = [];
        for ($i = 0; $i < 6; ++$i) {
            $claimed[] = $queues[$i % 2]->claimNext(['cleanup'])?->id;
        }
        self::assertCount(6, array_unique(array_filter($claimed)));
        self::assertNull($this->queue->claimNext(['cleanup']));
    }

    public function testSecondRunnerReturnsWhileTheFirstHoldsTheLock(): void
    {
        $other = Database::connect(Config::fromArray(['DATABASE_URL' => self::$config->get('DATABASE_URL')]));
        self::assertSame(1, (int) Database::run($other, 'SELECT GET_LOCK(?, 0)', [Runner::LOCK])->fetchColumn());
        $this->queue->enqueue('cleanup');
        $ran = false;
        $result = $this->runner(cleanup: self::handler(static function () use (&$ran): bool {
            $ran = true;

            return false;
        }))->runOnce(10);
        self::assertFalse($result['locked']);
        self::assertFalse($ran);
        Database::run($other, 'SELECT RELEASE_LOCK(?)', [Runner::LOCK]);
        self::assertSame(['locked' => true, 'done' => 1, 'failed' => 0], $this->runner(cleanup: self::handler(static fn(): bool => false))->runOnce(10));
    }

    public function testBrokenAccountDoesNotBlockTheHealthyOne(): void
    {
        $broken = $this->account('broken.example.org');
        $healthy = $this->account('healthy.example.org');
        $this->queue->enqueue('folder_sync', $broken);
        $this->queue->enqueue('folder_sync', $healthy);
        $synced = [];
        $result = $this->runner(folder_sync: self::handler(static function (Job $job) use ($broken, &$synced): bool {
            if ($job->accountId === $broken) {
                throw new AccountErrorException('TIMEOUT');
            }
            $synced[] = $job->accountId;

            return true;
        }))->runOnce(30);
        self::assertSame(['locked' => true, 'done' => 1, 'failed' => 1], $result);
        self::assertSame([$healthy], $synced);
        /** @var array{status: string, error_count: int, last_error_code: string, next_retry_at: ?string} $row */
        $row = $this->sql('SELECT status, error_count, last_error_code, next_retry_at FROM mail_account WHERE id = ?', [$broken])->fetch();
        self::assertSame(['ok', 1, 'TIMEOUT'], [$row['status'], (int) $row['error_count'], $row['last_error_code']]);
        self::assertNotNull($row['next_retry_at']);
        self::assertNotNull($this->sql('SELECT last_sync_at FROM mail_account WHERE id = ?', [$healthy])->fetchColumn());
        // The job error holds class and code only.
        self::assertSame('Fma\Jobs\AccountErrorException:TIMEOUT', $this->sql('SELECT last_error FROM job WHERE account_id = ?', [$broken])->fetchColumn());
    }

    public function testCircuitOpensAfterThreeFailuresAndClosesAfterSuccess(): void
    {
        $account = $this->account();
        $health = new AccountHealth(self::$db);
        $statuses = [];
        foreach ([1, 2, 3] as $n) {
            // Expired window: every failure counts.
            $this->sql('UPDATE mail_account SET next_retry_at = UTC_TIMESTAMP(6) - INTERVAL 1 SECOND WHERE id = ?', [$account]);
            $state = $health->recordFailure($account, new AccountErrorException('CONNECTION_REFUSED'));
            self::assertSame($n, $state['errorCount'] ?? null);
            $statuses[] = $state['status'];
        }
        self::assertSame(['ok', 'ok', 'unreachable'], $statuses);
        // Failures inside an open window do not count again.
        self::assertSame(3, $health->recordFailure($account, new AccountErrorException('TIMEOUT'))['errorCount'] ?? null);
        $delay = (int) $this->sql('SELECT TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(6), next_retry_at) FROM mail_account WHERE id = ?', [$account])->fetchColumn();
        self::assertEqualsWithDelta(240, $delay, 2, '60 s * 2^(3-1)');

        $health->recordSuccess($account);
        $row = $this->sql('SELECT status, error_count, next_retry_at FROM mail_account WHERE id = ?', [$account])->fetch(\PDO::FETCH_NUM);
        self::assertSame(['ok', 0, null], \is_array($row) ? [$row[0], (int) $row[1], $row[2]] : null);
    }

    public function testAuthErrorStopsRetries(): void
    {
        $account = $this->account();
        $state = (new AccountHealth(self::$db))->recordFailure($account, new AccountErrorException('AUTH_FAILED'));
        self::assertSame('auth_error', $state['status'] ?? null);
        self::assertNull($state['nextRetryAt'] ?? null);
        $this->queue->enqueue('folder_sync', $account);
        self::assertNull($this->queue->claimNext(['folder_sync']));
        self::assertSame(0, $this->queue->enqueueDueSyncs(1));
    }

    public function testPriorityTypesAreClaimedFirstAndUnportedTypesStayQueued(): void
    {
        $this->queue->enqueue('cleanup');
        $send = $this->queue->enqueue('send_message', $this->account());
        $unported = $this->queue->enqueue('push_notify');
        $order = [];
        $record = static function (Job $job) use (&$order): bool {
            $order[] = $job->type;

            return false;
        };
        $this->runner(cleanup: self::handler($record), send_message: self::handler($record))->runOnce(30);
        self::assertSame(['send_message', 'cleanup'], $order);
        self::assertSame('done', $this->state($send));
        self::assertSame('queued', $this->state($unported));
    }

    public function testCoalescesDraftSync(): void
    {
        $account = $this->account();
        $this->queue->enqueueDraftSync($account, 'd1', 30);
        $this->queue->enqueueDraftSync($account, 'd1', 60);
        $this->queue->enqueueDraftSync($account, 'd1', 0);
        $this->queue->enqueueDraftSync($account, 'd2', 0);
        self::assertSame(2, (int) $this->sql("SELECT COUNT(*) FROM job WHERE type = 'draft_sync'")->fetchColumn());
        self::assertSame(1, (int) $this->sql("SELECT COUNT(*) FROM job WHERE type = 'draft_sync' AND run_at <= UTC_TIMESTAMP(6) AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.draftId')) = 'd1'")->fetchColumn());
    }
}
