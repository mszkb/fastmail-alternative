<?php

declare(strict_types=1);

namespace Fma\Tests\Integration;

use Fma\App;
use Fma\Auth\Sessions;
use Fma\Config;
use Fma\Db\Database;
use Fma\Db\Migrator;
use Fma\Db\Uuid;
use Fma\Jobs\AccountHealth;
use Fma\Jobs\Deadline;
use Fma\Jobs\Job;
use Fma\Jobs\JobCancelledException;
use Fma\Jobs\JobHandler;
use Fma\Jobs\JobQueue;
use Fma\Jobs\Runner;
use Fma\Jobs\SyncProgress;
use Fma\Log\Logger;
use Fma\Tests\Support\FakeConnectionTester;
use Fma\Tests\Support\Http;
use Psr\Http\Message\ResponseInterface;

/** Sync status, progress and cancellation without a mail server (#119). */
final class SyncStatusTest extends DatabaseTestCase
{
    /** @var \Slim\App<\Psr\Container\ContainerInterface|null> */
    private \Slim\App $app;
    private \PDO $pdo;
    private JobQueue $queue;
    private string $userId;
    private string $token;

    protected function setUp(): void
    {
        $this->pdo = self::$db->pdo();
        foreach (['job', 'mail_account', '`user`'] as $table) {
            $this->pdo->exec("DELETE FROM {$table}");
        }
        $config = Config::fromArray(['DATABASE_URL' => self::$config->get('DATABASE_URL'), 'DOMAIN' => 'mail.example.org', 'SYNC_INTERVAL_SECONDS' => '120']);
        $this->app = App::create($config, self::$db, new Logger('api', 'info', Http::memoryStream()), [], new FakeConnectionTester());
        $this->queue = new JobQueue(self::$db);
        $this->userId = $this->user('me@example.org');
        $this->token = (new Sessions(self::$db))->createDeviceWithSession($this->userId, 'Test', 'desktop');
    }

    private function user(string $email): string
    {
        $id = Uuid::v4();
        Database::run($this->pdo, 'INSERT INTO `user` (id, email, password_hash) VALUES (?, ?, ?)', [$id, $email, 'unused']);

        return $id;
    }

    private function account(?string $userId = null, string $status = 'ok', int $sortOrder = 0): string
    {
        $id = Uuid::v4();
        Database::run(
            $this->pdo,
            'INSERT INTO mail_account (id, user_id, display_name, email_address, imap_host, imap_port, smtp_host, smtp_port,
               wrapped_dek, key_id, credential_enc, status, sort_order) VALUES (?, ?, ?, ?, ?, 993, ?, 465, ?, ?, ?, ?, ?)',
            [$id, $userId ?? $this->userId, 'Geheimkonto', 'geheim@example.org', 'imap.example.org', 'smtp.example.org', 'w', 'v1', 'c', $status, $sortOrder],
        );

        return $id;
    }

    /** @param list<mixed> $params */
    private function sql(string $sql, array $params = []): \PDOStatement
    {
        return Database::run($this->pdo, $sql, $params);
    }

    private function call(string $method, string $path, bool $auth = true, string $site = 'same-origin'): ResponseInterface
    {
        $request = Http::request($method, $path, ['Sec-Fetch-Site' => $site]);
        if ($auth) {
            $request = $request->withCookieParams(['fma_session' => $this->token]);
        }

        return $this->app->handle($request);
    }

    /** @return array<string, array<string, mixed>> by account id */
    private function syncStatus(): array
    {
        $response = $this->call('GET', '/api/sync/status');
        self::assertSame(200, $response->getStatusCode());
        $result = [];
        foreach (Http::json($response)['accounts'] as $entry) {
            \assert(\is_array($entry) && \is_string($entry['accountId']));
            $result[$entry['accountId']] = $entry;
        }

        return $result;
    }

    private function state(string $jobId): string
    {
        return (string) $this->sql('SELECT state FROM job WHERE id = ?', [$jobId])->fetchColumn();
    }

    /** @param callable(Job, Deadline): bool $fn */
    private function runner(string $type, callable $fn): Runner
    {
        $runner = new Runner(self::$db, $this->queue, new AccountHealth(self::$db), new Logger('worker', 'error', Http::memoryStream()), Config::fromArray([]));
        $runner->register($type, new class ($fn) implements JobHandler {
            /** @param callable(Job, Deadline): bool $fn */
            public function __construct(private $fn) {}

            public function run(Job $job, Deadline $deadline): bool
            {
                return ($this->fn)($job, $deadline);
            }
        });

        return $runner;
    }

    public function testStatusReportsStatesProgressAndOnlyIdsAndNumbers(): void
    {
        $idle = $this->account(sortOrder: 1);
        $running = $this->account(sortOrder: 2);
        $queued = $this->account(sortOrder: 3);
        $authError = $this->account(status: 'auth_error', sortOrder: 4);
        $paused = $this->account(status: 'disabled', sortOrder: 5);
        $backoff = $this->account(sortOrder: 6);
        $foreign = $this->account($this->user('other@example.org'));
        $this->sql("UPDATE mail_account SET last_error_code = 'AUTH_FAILED' WHERE id = ?", [$authError]);
        $this->sql("UPDATE mail_account SET next_retry_at = UTC_TIMESTAMP(6) + INTERVAL 10 MINUTE, last_error_code = 'TIMEOUT', status = 'unreachable' WHERE id = ?", [$backoff]);
        $this->sql("UPDATE mail_account SET last_sync_at = '2026-10-07 10:00:00' WHERE id = ?", [$idle]);
        $this->queue->enqueue('folder_sync', $idle);
        $this->sql("UPDATE job SET state = 'done', created_at = UTC_TIMESTAMP(6) - INTERVAL 30 SECOND");

        $folder = Uuid::v4();
        $jobId = $this->queue->enqueue('message_sync', $running, ['folderId' => $folder]);
        $this->queue->enqueue('message_sync', $running, ['folderId' => Uuid::v4()]);
        $job = $this->queue->claimNext(['message_sync']);
        self::assertNotNull($job);
        self::assertSame($jobId, $job->id);
        $this->queue->progress($job->id)->report('headers', $folder, 1240, 8000);
        $this->queue->enqueue('folder_sync', $queued);
        // A retry in the future is no running sync, the client must not poll for it.
        $this->queue->enqueue('message_sync', $paused, ['folderId' => Uuid::v4()], 600);

        self::assertSame(401, $this->call('GET', '/api/sync/status', auth: false)->getStatusCode());
        $status = $this->syncStatus();
        self::assertSame([$idle, $running, $queued, $authError, $paused, $backoff], array_keys($status), 'own accounts in account order');
        self::assertArrayNotHasKey($foreign, $status);

        self::assertSame('idle', $status[$idle]['state']);
        self::assertSame('2026-10-07T10:00:00.000Z', $status[$idle]['lastSyncAt']);
        self::assertNull($status[$idle]['phase']);
        self::assertIsString($status[$idle]['nextRunAt']);
        $next = new \DateTimeImmutable((string) $status[$idle]['nextRunAt']);
        self::assertEqualsWithDelta(time() + 90, $next->getTimestamp(), 5, 'last folder_sync + SYNC_INTERVAL_SECONDS');

        self::assertSame('running', $status[$running]['state']);
        self::assertSame('headers', $status[$running]['phase']);
        self::assertSame($folder, $status[$running]['folderId']);
        self::assertSame(1240, $status[$running]['done']);
        self::assertSame(8000, $status[$running]['total']);
        self::assertSame(1, $status[$running]['queuedJobs']);
        self::assertIsString($status[$running]['startedAt']);
        self::assertIsString($status[$running]['updatedAt']);
        self::assertNull($status[$running]['nextRunAt']);

        self::assertSame('queued', $status[$queued]['state']);
        self::assertSame('auth_error', $status[$authError]['state']);
        self::assertSame('AUTH_FAILED', $status[$authError]['lastErrorCode']);
        self::assertNull($status[$authError]['nextRunAt']);
        self::assertSame('paused', $status[$paused]['state']);
        self::assertSame('error', $status[$backoff]['state']);
        self::assertSame('TIMEOUT', $status[$backoff]['lastErrorCode']);
        self::assertIsString($status[$backoff]['nextRunAt']);

        // Principles 5/6: no names or addresses, only ids, numbers, codes and times.
        $body = (string) $this->call('GET', '/api/sync/status')->getBody();
        foreach (['Geheimkonto', 'geheim@example.org', 'imap.example.org'] as $plain) {
            self::assertStringNotContainsString($plain, $body);
        }
        foreach ($status as $entry) {
            self::assertSame(['accountId', 'state', 'phase', 'folderId', 'done', 'total', 'startedAt', 'updatedAt', 'queuedJobs', 'lastSyncAt', 'nextRunAt', 'lastErrorCode'], array_keys($entry));
        }
    }

    public function testCancelStopsQueuedAndAsksRunningSyncsOfOneAccountOnly(): void
    {
        $a = $this->account(sortOrder: 1);
        $b = $this->account(sortOrder: 2);
        $foreign = $this->account($this->user('other@example.org'));
        $running = $this->queue->enqueue('message_sync', $a, ['folderId' => Uuid::v4()]);
        self::assertSame($running, $this->queue->claimNext(['message_sync'])?->id);
        $queuedA = $this->queue->enqueue('message_sync', $a, ['folderId' => Uuid::v4()]);
        $sendA = $this->queue->enqueue('send_message', $a, ['outboxId' => Uuid::v4()]);
        $queuedB = $this->queue->enqueue('folder_sync', $b);
        $queuedForeign = $this->queue->enqueue('folder_sync', $foreign);

        // Auth, ownership and CSRF like every other route.
        self::assertSame(401, $this->call('POST', "/api/accounts/{$a}/sync/cancel", auth: false)->getStatusCode());
        self::assertSame(403, $this->call('POST', "/api/accounts/{$a}/sync/cancel", site: 'cross-site')->getStatusCode());
        self::assertSame(403, $this->call('POST', '/api/sync/cancel', site: 'cross-site')->getStatusCode());
        self::assertSame(404, $this->call('POST', "/api/accounts/{$foreign}/sync/cancel")->getStatusCode());
        self::assertSame(404, $this->call('POST', '/api/accounts/not-an-id/sync/cancel')->getStatusCode());
        self::assertSame('queued', $this->state($queuedForeign));
        self::assertSame('running', $this->state($running));

        $response = $this->call('POST', "/api/accounts/{$a}/sync/cancel");
        self::assertSame(200, $response->getStatusCode());
        self::assertSame(['accountId' => $a, 'cancelledQueued' => 1, 'cancelling' => true], Http::json($response));
        self::assertSame('cancelled', $this->state($queuedA));
        self::assertSame('running', $this->state($running), 'stops cooperatively');
        self::assertSame('queued', $this->state($sendA), 'only syncs are stopped');
        self::assertSame('queued', $this->state($queuedB), 'other accounts are not touched');
        self::assertSame('cancelling', $this->syncStatus()[$a]['state']);
        self::assertSame('queued', $this->syncStatus()[$b]['state']);

        // The handler sees the request and ends the job as cancelled, never retried.
        $progress = $this->queue->progress($running);
        self::assertTrue($progress->cancelled());
        $this->queue->markCancelled($running);
        self::assertSame('cancelled', $this->state($running));
        self::assertSame('idle', $this->syncStatus()[$a]['state']);

        self::assertSame(['accounts' => [
            ['accountId' => $a, 'cancelledQueued' => 0, 'cancelling' => false],
            ['accountId' => $b, 'cancelledQueued' => 1, 'cancelling' => false],
        ]], Http::json($this->call('POST', '/api/sync/cancel')));
        self::assertSame('queued', $this->state($queuedForeign));
    }

    public function testSyncCanBeRequestedRightAfterStopping(): void
    {
        $a = $this->account();
        self::assertSame(202, $this->call('POST', "/api/accounts/{$a}/sync")->getStatusCode());
        self::assertSame(200, $this->call('POST', "/api/accounts/{$a}/sync/cancel")->getStatusCode());
        // The stopped folder_sync does not count for the 30 s rate limit.
        self::assertSame(202, $this->call('POST', "/api/accounts/{$a}/sync")->getStatusCode());
        // A finished one does.
        $this->sql("UPDATE job SET state = 'done' WHERE state = 'queued'");
        self::assertSame(429, $this->call('POST', "/api/accounts/{$a}/sync")->getStatusCode());
        // The scheduler still waits for the regular interval after a stop.
        $this->sql("UPDATE job SET state = 'cancelled'");
        self::assertSame(0, $this->queue->enqueueDueSyncs(120));
    }

    public function testRunnerEndsCancelledJobsWithoutRetryOrAccountFailure(): void
    {
        $a = $this->account();
        $jobId = $this->queue->enqueue('folder_sync', $a);
        $runner = $this->runner('folder_sync', function (Job $job): bool {
            $this->queue->cancelSyncs((string) $job->accountId);

            throw new JobCancelledException();
        });
        self::assertSame(['done' => 1, 'failed' => 0], $runner->work(new Deadline(30)));
        self::assertSame('cancelled', $this->state($jobId));
        self::assertSame('ok', $this->sql('SELECT status FROM mail_account WHERE id = ?', [$a])->fetchColumn());

        // An error after a cancel request: cancelled as well, no backoff retry.
        $jobId = $this->queue->enqueue('folder_sync', $a);
        $runner = $this->runner('folder_sync', function (Job $job): bool {
            $this->queue->cancelSyncs((string) $job->accountId);

            throw new \RuntimeException('boom');
        });
        self::assertSame(['done' => 0, 'failed' => 1], $runner->work(new Deadline(30)));
        self::assertSame('cancelled', $this->state($jobId));

        // A lost job (worker killed) that was asked to cancel is not re-queued.
        $jobId = $this->queue->enqueue('message_sync', $a, ['folderId' => Uuid::v4()]);
        self::assertSame($jobId, $this->queue->claimNext(['message_sync'])?->id);
        $this->queue->cancelSyncs($a);
        $this->sql('UPDATE job SET locked_at = UTC_TIMESTAMP(6) - INTERVAL 1 HOUR WHERE id = ?', [$jobId]);
        $this->queue->requeueStale(1800);
        self::assertSame('cancelled', $this->state($jobId));
    }

    public function testNothingIsChainedAfterACancelRequest(): void
    {
        $a = $this->account();
        $jobId = $this->queue->enqueue('folder_sync', $a);
        $job = $this->queue->claimNext(['folder_sync']);
        self::assertNotNull($job);
        $folder = Uuid::v4();
        self::assertTrue($this->queue->chainUnlessCancelled($job, fn() => $this->queue->enqueueMessageSync($a, $folder)));
        self::assertSame(1, (int) $this->sql("SELECT COUNT(*) FROM job WHERE type = 'message_sync' AND state = 'queued'")->fetchColumn());

        $this->queue->cancelSyncs($a);
        self::assertFalse($this->queue->chainUnlessCancelled($job, fn() => $this->queue->enqueueMessageSync($a, Uuid::v4())));
        self::assertSame(0, (int) $this->sql("SELECT COUNT(*) FROM job WHERE type = 'message_sync' AND state = 'queued'")->fetchColumn());
        self::assertSame('running', $this->state($jobId));
    }

    public function testMigrationCanRunAgain(): void
    {
        // MySQL commits DDL implicitly: a re-run after a failure must be safe.
        foreach (Migrator::statements((string) file_get_contents(__DIR__ . '/../../migrations/0004_sync_progress.sql')) as $sql) {
            $this->pdo->exec($sql);
        }
        $columns = $this->sql(
            "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'job'
               AND (COLUMN_NAME LIKE 'progress\\_%' OR COLUMN_NAME = 'cancel_requested_at') ORDER BY COLUMN_NAME",
        )->fetchAll(\PDO::FETCH_COLUMN);
        self::assertSame(['cancel_requested_at', 'progress_done', 'progress_folder_id', 'progress_phase', 'progress_total', 'progress_updated_at'], $columns);
    }

    public function testProgressWritesAreThrottled(): void
    {
        $a = $this->account();
        $jobId = $this->queue->enqueue('message_sync', $a, ['folderId' => Uuid::v4()]);
        self::assertNotNull($this->queue->claimNext(['message_sync']));
        $now = 1000.0;
        $progress = new SyncProgress(self::$db, $jobId, function () use (&$now): float {
            return $now;
        });
        $done = fn(): mixed => $this->sql('SELECT progress_done FROM job WHERE id = ?', [$jobId])->fetchColumn();
        $folder = Uuid::v4();

        $progress->report('headers', $folder, 0, 100);
        self::assertSame(0, (int) $done());
        $now += 0.5;
        $progress->report('headers', $folder, 50, 100);
        self::assertSame(0, (int) $done(), 'no write within 2 s');
        $now += 2.0;
        $progress->report('headers', $folder, 60, 100);
        self::assertSame(60, (int) $done());
        $now += 0.1;
        $progress->report('bodies', $folder, 1, 3);
        self::assertSame(1, (int) $done(), 'a phase change is written at once');
        self::assertSame('bodies', $this->sql('SELECT progress_phase FROM job WHERE id = ?', [$jobId])->fetchColumn());

        $this->expectException(\InvalidArgumentException::class);
        $progress->report('Posteingang', $folder);
    }
}
