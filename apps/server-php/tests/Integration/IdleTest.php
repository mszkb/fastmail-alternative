<?php

declare(strict_types=1);

namespace Fma\Tests\Integration;

use Fma\Config;
use Fma\Crypto\Envelope;
use Fma\Db\Database;
use Fma\Db\Uuid;
use Fma\Jobs\IdleManager;
use Fma\Jobs\JobQueue;
use Fma\Log\Logger;
use Fma\Mail\HostConfig;
use Fma\Mail\ImapClient;
use Fma\Mail\TransportPolicy;

/**
 * IMAP IDLE in the long-running worker against GreenMail (GREENMAIL_HOST,
 * IMAP 3143, any login accepted). Port of apps/worker/test/idle.test.ts.
 */
final class IdleTest extends DatabaseTestCase
{
    private string $greenmail = '';
    private string $masterKey;
    private TransportPolicy $policy;

    protected function setUp(): void
    {
        $host = getenv('GREENMAIL_HOST');
        if (!\is_string($host) || $host === '') {
            self::markTestSkipped('GREENMAIL_HOST not set');
        }
        $this->greenmail = $host;
        $this->masterKey = base64_encode(random_bytes(32));
        $this->policy = new TransportPolicy(allowPrivateHosts: true, insecureTransport: true);
    }

    /** @return array{0: string, 1: string} account id, INBOX folder id */
    private function account(string $user, int $port = 3143): array
    {
        $pdo = self::$db->pdo();
        $userId = Uuid::v4();
        Database::run($pdo, 'INSERT INTO `user` (id, email, password_hash) VALUES (?, ?, ?)', [$userId, $userId . '@owner.test', 'x']);
        $id = Uuid::v4();
        $dek = Envelope::generateDataKey();
        Database::run(
            $pdo,
            'INSERT INTO mail_account (id, user_id, display_name, email_address, imap_host, imap_port, smtp_host, smtp_port, wrapped_dek, key_id, credential_enc)
             VALUES (?, ?, ?, ?, ?, ?, ?, 3025, ?, ?, ?)',
            [$id, $userId, 'Idle', $user, $this->greenmail, $port, $this->greenmail, Envelope::wrapDataKey(Envelope::loadMasterKey($this->masterKey), $dek, 'v1'), 'v1',
                Envelope::encryptField($dek, json_encode(['imapUser' => $user, 'imapPassword' => 'pw'], JSON_THROW_ON_ERROR), Envelope::credentialAad($id))],
        );
        $folderId = Uuid::v4();
        Database::run($pdo, "INSERT INTO folder (id, account_id, path) VALUES (?, ?, 'INBOX')", [$folderId, $id]);

        return [$id, $folderId];
    }

    private function syncJobs(string $accountId, string $folderId): int
    {
        return (int) Database::run(
            self::$db->pdo(),
            "SELECT COUNT(*) FROM job WHERE type = 'message_sync' AND account_id = ? AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.folderId')) = ?",
            [$accountId, $folderId],
        )->fetchColumn();
    }

    private function deliver(string $user, string $subject): void
    {
        $imap = ImapClient::connect($this->policy, new HostConfig($this->greenmail, 3143, false, $user, 'pw'));
        $raw = "From: sender@example.org\r\nTo: {$user}\r\nSubject: {$subject}\r\n\r\nIDLE test mail.\r\n";
        $imap->execute(['APPEND INBOX ', $raw, '']);
        $imap->logout();
    }

    /** Polls the manager until `$check` holds or the timeout ends. */
    private static function pollUntil(IdleManager $manager, callable $check, float $timeout = 10.0): bool
    {
        $end = microtime(true) + $timeout;
        while (microtime(true) < $end) {
            $manager->poll(0.2);
            if ($check() === true) {
                return true;
            }
        }

        return false;
    }

    /** @param resource $logStream */
    private function manager($logStream, int $idleRestartSeconds = IdleManager::IDLE_RESTART_SECONDS): IdleManager
    {
        return new IdleManager(
            self::$db,
            new JobQueue(self::$db),
            Config::fromArray(['MASTER_KEY' => $this->masterKey]),
            new Logger('test', 'debug', $logStream),
            $this->policy,
            reconcileSeconds: 1,
            syncMinIntervalSeconds: 0,
            idleRestartSeconds: $idleRestartSeconds,
        );
    }

    public function testEnqueuesInboxSyncOnNewMailAndIsolatesAccounts(): void
    {
        $user = 'idle-' . bin2hex(random_bytes(4)) . '@example.org';
        [$good, $goodFolder] = $this->account($user);
        [$bad, $badFolder] = $this->account('idle-refused@example.org', 3999);
        [$disabled] = $this->account($user);
        [$authError] = $this->account($user);
        Database::run(self::$db->pdo(), "UPDATE mail_account SET status = 'disabled' WHERE id = ?", [$disabled]);
        Database::run(self::$db->pdo(), "UPDATE mail_account SET status = 'auth_error' WHERE id = ?", [$authError]);
        $log = fopen('php://memory', 'w+');
        self::assertIsResource($log);

        $manager = $this->manager($log);
        try {
            $manager->reconcile();
            $managed = $manager->managedAccountIds();
            sort($managed);
            $expected = [$good, $bad];
            sort($expected);
            self::assertSame($expected, $managed);
            self::assertTrue(self::pollUntil($manager, static fn(): bool => \in_array($good, $manager->connectedAccountIds(), true)));
            self::assertNotContains($bad, $manager->connectedAccountIds());
            Database::run(self::$db->pdo(), 'DELETE FROM job WHERE account_id = ?', [$good]);

            $this->deliver($user, 'Secret IDLE subject');
            self::assertTrue(self::pollUntil($manager, fn(): bool => $this->syncJobs($good, $goodFolder) > 0, 5.0));
            // Deduplicated: further events while the job is queued add nothing.
            $manager->poll(0.5);
            self::assertSame(1, $this->syncJobs($good, $goodFolder));
            self::assertSame(0, $this->syncJobs($bad, $badFolder));

            // Disabling an account closes its connection on the next reconcile.
            Database::run(self::$db->pdo(), "UPDATE mail_account SET status = 'disabled' WHERE id = ?", [$good]);
            self::assertTrue(self::pollUntil($manager, static fn(): bool => !\in_array($good, $manager->managedAccountIds(), true)));
            Database::run(self::$db->pdo(), "UPDATE mail_account SET status = 'ok' WHERE id = ?", [$good]);
            self::assertTrue(self::pollUntil($manager, static fn(): bool => \in_array($good, $manager->connectedAccountIds(), true)));

            // A deleted account is dropped as well.
            Database::run(self::$db->pdo(), 'DELETE FROM mail_account WHERE id = ?', [$bad]);
            self::assertTrue(self::pollUntil($manager, static fn(): bool => !\in_array($bad, $manager->managedAccountIds(), true)));
        } finally {
            $manager->stop();
        }
        self::assertSame([], $manager->managedAccountIds());
        self::assertSame([], $manager->connectedAccountIds());

        rewind($log);
        $output = (string) stream_get_contents($log);
        self::assertStringContainsString('idle connected', $output);
        self::assertStringContainsString('idle connect failed', $output);
        self::assertStringNotContainsString('Secret IDLE subject', $output);
        self::assertStringNotContainsString($user, $output);
    }

    public function testRestartsIdleBeforeTheServerLimit(): void
    {
        $user = 'idle-' . bin2hex(random_bytes(4)) . '@example.org';
        [$account, $folder] = $this->account($user);
        $log = fopen('php://memory', 'w+');
        self::assertIsResource($log);
        $manager = $this->manager($log, idleRestartSeconds: 1);
        try {
            self::assertTrue(self::pollUntil($manager, static fn(): bool => \in_array($account, $manager->connectedAccountIds(), true)));
            // Several DONE/IDLE cycles without losing the connection.
            $end = microtime(true) + 3.5;
            while (microtime(true) < $end) {
                $manager->poll(0.2);
            }
            self::assertSame([$account], $manager->connectedAccountIds());
            Database::run(self::$db->pdo(), 'DELETE FROM job WHERE account_id = ?', [$account]);
            $this->deliver($user, 'After re-IDLE');
            self::assertTrue(self::pollUntil($manager, fn(): bool => $this->syncJobs($account, $folder) > 0, 5.0));
        } finally {
            $manager->stop();
        }
        rewind($log);
        self::assertStringNotContainsString('idle connection closed', (string) stream_get_contents($log));
    }

    public function testBackoff(): void
    {
        self::assertSame(5.0, IdleManager::backoffSeconds(1, static fn(): float => 1.0));
        self::assertSame(2.5, IdleManager::backoffSeconds(1, static fn(): float => 0.0));
        self::assertSame(20.0, IdleManager::backoffSeconds(3, static fn(): float => 1.0));
        self::assertSame(1800.0, IdleManager::backoffSeconds(50, static fn(): float => 1.0));
        self::assertSame(4, IdleManager::failuresAfterClose(3, 2.0));
        self::assertSame(1, IdleManager::failuresAfterClose(0, 0.0));
        self::assertSame(1, IdleManager::failuresAfterClose(5, IdleManager::STABLE_SECONDS));
        self::assertFalse(IdleManager::enabled(Config::fromArray(['IMAP_IDLE' => '0'])));
        self::assertTrue(IdleManager::enabled(Config::fromArray([])));
        self::assertSame(0, IdleManager::syncMinInterval(Config::fromArray(['SYNC_MIN_INTERVAL_SECONDS' => '0'])));
        self::assertSame(10, IdleManager::syncMinInterval(Config::fromArray([])));
    }
}
