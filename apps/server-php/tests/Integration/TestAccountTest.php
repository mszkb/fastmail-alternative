<?php

declare(strict_types=1);

namespace Fma\Tests\Integration;

use Fma\Config;
use Fma\Crypto\Envelope;
use Fma\Db\Database;
use Fma\Db\Uuid;
use Fma\Install\TestAccount;
use Fma\Jobs\JobQueue;
use Fma\Tests\Support\FakeConnectionTester;

final class TestAccountTest extends DatabaseTestCase
{
    private const ENV = [
        'LIVE_MAIL_USER' => 'tester@gmx.example',
        'LIVE_MAIL_PASSWORD' => 'live-secret',
        'LIVE_IMAP_HOST' => 'imap.gmx.example',
        'LIVE_IMAP_PORT' => '',
        'LIVE_SMTP_HOST' => 'mail.gmx.example',
        'LIVE_SMTP_PORT' => '',
    ];

    private Config $instance;
    private FakeConnectionTester $tester;

    protected function setUp(): void
    {
        $pdo = self::$db->pdo();
        foreach (['job', 'identity', 'mail_account', '`user`'] as $table) {
            $pdo->exec("DELETE FROM {$table}");
        }
        $this->instance = Config::fromArray(['DATABASE_URL' => self::$config->get('DATABASE_URL'), 'MASTER_KEY' => base64_encode(random_bytes(32))]);
        $this->tester = new FakeConnectionTester();
    }

    /**
     * @param array<string, string> $env
     *
     * @return array{status: 'added'|'exists', accountId: string}
     */
    private function add(array $env = self::ENV): array
    {
        return TestAccount::add(self::$db, $this->instance, $this->tester, new JobQueue(self::$db), $env);
    }

    private function createUser(string $email = 'me@example.org'): string
    {
        $id = Uuid::v4();
        Database::run(self::$db->pdo(), 'INSERT INTO `user` (id, email, password_hash) VALUES (?, ?, ?)', [$id, $email, 'unused']);

        return $id;
    }

    public function testAddsTheAccountWithEncryptedCredentialsAndQueuesTheSync(): void
    {
        $userId = $this->createUser();

        $result = $this->add();

        self::assertSame('added', $result['status']);
        /** @var array{user_id: string, display_name: string, imap_port: int, smtp_port: int, wrapped_dek: string, credential_enc: string} $row */
        $row = Database::run(self::$db->pdo(), 'SELECT user_id, display_name, imap_port, smtp_port, wrapped_dek, credential_enc FROM mail_account WHERE id = ?', [$result['accountId']])->fetch();
        self::assertSame($userId, $row['user_id']);
        self::assertSame(TestAccount::DISPLAY_NAME, $row['display_name']);
        self::assertSame([993, 587], [(int) $row['imap_port'], (int) $row['smtp_port']]);
        self::assertStringNotContainsString('live-secret', $row['credential_enc']);
        $dek = Envelope::unwrapAccountKey($this->instance->get('MASTER_KEY'), $row['wrapped_dek']);
        $credentials = json_decode(Envelope::decryptField($dek, $row['credential_enc'], Envelope::credentialAad($result['accountId'])), true);
        self::assertSame('live-secret', $credentials['imapPassword']);
        self::assertSame(1, (int) Database::run(self::$db->pdo(), "SELECT COUNT(*) FROM job WHERE type = 'folder_sync' AND account_id = ?", [$result['accountId']])->fetchColumn());
    }

    public function testSecondRunKeepsTheExistingAccount(): void
    {
        $this->createUser();
        $first = $this->add();
        $this->tester->reset();

        $second = $this->add(['LIVE_MAIL_USER' => 'Tester@GMX.example'] + self::ENV);

        self::assertSame(['status' => 'exists', 'accountId' => $first['accountId']], $second);
        self::assertSame([], $this->tester->calls, 'no connection test for an existing account');
        self::assertSame(1, (int) Database::run(self::$db->pdo(), 'SELECT COUNT(*) FROM mail_account')->fetchColumn());
    }

    public function testFailedConnectionTestStoresNothing(): void
    {
        $this->createUser();
        $this->tester->imapCode = 'AUTH_FAILED';

        try {
            $this->add();
            self::fail('expected a failed connection test');
        } catch (\RuntimeException $e) {
            self::assertSame('IMAP connection test failed: AUTH_FAILED', $e->getMessage());
        }
        self::assertSame(0, (int) Database::run(self::$db->pdo(), 'SELECT COUNT(*) FROM mail_account')->fetchColumn());
    }

    public function testRefusesWithoutCredentialsOrUser(): void
    {
        try {
            $this->add(['LIVE_MAIL_PASSWORD' => ''] + self::ENV);
            self::fail('expected missing credentials');
        } catch (\RuntimeException $e) {
            self::assertStringContainsString('LIVE_MAIL_PASSWORD', $e->getMessage());
        }
        try {
            $this->add();
            self::fail('expected missing user');
        } catch (\RuntimeException $e) {
            self::assertStringContainsString('setup is not completed', $e->getMessage());
        }
        self::assertSame([], $this->tester->calls);
    }

    public function testRefusesALoginThatIsNoEmailAddress(): void
    {
        $this->createUser();

        try {
            $this->add(['LIVE_MAIL_USER' => 'tester'] + self::ENV);
            self::fail('expected an invalid address');
        } catch (\RuntimeException $e) {
            self::assertStringContainsString('must be an email address', $e->getMessage());
        }
        self::assertSame([], $this->tester->calls);
    }

    public function testRefusesToPickOneOfSeveralUsers(): void
    {
        $this->createUser();
        $this->createUser('other@example.org');

        try {
            $this->add();
            self::fail('expected more than one user');
        } catch (\RuntimeException $e) {
            self::assertStringContainsString('more than one user', $e->getMessage());
        }
        self::assertSame(0, (int) Database::run(self::$db->pdo(), 'SELECT COUNT(*) FROM mail_account')->fetchColumn());
    }
}
