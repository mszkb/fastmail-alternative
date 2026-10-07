<?php

declare(strict_types=1);

namespace Fma\Tests\Integration;

use Fma\Config;
use Fma\Crypto\Envelope;
use Fma\Db\Database;
use Fma\Db\Uuid;
use Fma\Jobs\AccountErrorException;
use Fma\Jobs\Deadline;
use Fma\Jobs\FolderSyncJob;
use Fma\Jobs\Job;
use Fma\Jobs\JobQueue;
use Fma\Mail\HostConfig;
use Fma\Mail\ImapClient;
use Fma\Mail\TransportPolicy;

/** folder_sync against GreenMail (GREENMAIL_HOST, IMAP 3143, any login accepted). */
final class FolderSyncTest extends DatabaseTestCase
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

    private function account(string $user, string $password = 'pw'): string
    {
        $pdo = self::$db->pdo();
        $userId = Uuid::v4();
        Database::run($pdo, 'INSERT INTO `user` (id, email, password_hash) VALUES (?, ?, ?)', [$userId, "{$user}.owner", 'x']);
        $id = Uuid::v4();
        $dek = Envelope::generateDataKey();
        Database::run(
            $pdo,
            'INSERT INTO mail_account (id, user_id, display_name, email_address, imap_host, imap_port, smtp_host, smtp_port, wrapped_dek, key_id, credential_enc)
             VALUES (?, ?, ?, ?, ?, 3143, ?, 3025, ?, ?, ?)',
            [$id, $userId, 'K', $user, $this->greenmail, $this->greenmail, Envelope::wrapDataKey(Envelope::loadMasterKey($this->masterKey), $dek, 'v1'), 'v1',
                Envelope::encryptField($dek, json_encode(['imapUser' => $user, 'imapPassword' => $password], JSON_THROW_ON_ERROR), Envelope::credentialAad($id))],
        );

        return $id;
    }

    private function sync(string $accountId): bool
    {
        $job = new FolderSyncJob(self::$db, Config::fromArray(['MASTER_KEY' => $this->masterKey]), new JobQueue(self::$db), $this->policy);

        return $job->run(new Job('1', 'folder_sync', $accountId, [], 1), new Deadline(30));
    }

    private function imap(string $user): ImapClient
    {
        return ImapClient::connect($this->policy, new HostConfig($this->greenmail, 3143, false, $user, 'pw'));
    }

    /** @return array<string, array{special_use: ?string, selectable: int|string}> */
    private function folders(string $accountId): array
    {
        $rows = Database::run(self::$db->pdo(), 'SELECT path, special_use, selectable FROM folder WHERE account_id = ? ORDER BY path', [$accountId])->fetchAll();
        $result = [];
        foreach ($rows as $row) {
            /** @var array{path: string, special_use: ?string, selectable: int|string} $row */
            $result[$row['path']] = ['special_use' => $row['special_use'], 'selectable' => (int) $row['selectable']];
        }

        return $result;
    }

    public function testListsFoldersDetectsRolesAndChainsMessageSyncs(): void
    {
        $user = 'fs-' . bin2hex(random_bytes(4)) . '@example.org';
        $imap = $this->imap($user);
        foreach (['Entwürfe', 'Sent Items', 'Archiv/2025', 'Privat'] as $folder) {
            $imap->command('CREATE ' . ImapClient::quote(ImapClient::encodeMailbox($folder)));
        }
        $imap->logout();
        $account = $this->account($user);

        self::assertTrue($this->sync($account));
        $folders = $this->folders($account);
        self::assertSame('inbox', $folders['INBOX']['special_use']);
        self::assertSame('drafts', $folders['Entwürfe']['special_use']);
        self::assertSame('sent', $folders['Sent Items']['special_use']);
        self::assertNull($folders['Privat']['special_use']);
        self::assertArrayHasKey('Archiv/2025', $folders);
        $syncs = (int) Database::run(self::$db->pdo(), "SELECT COUNT(*) FROM job WHERE type = 'message_sync' AND account_id = ?", [$account])->fetchColumn();
        self::assertSame(\count(array_filter($folders, static fn(array $f): bool => $f['selectable'] === 1)), $syncs);

        // Idempotent; a folder deleted on the server disappears.
        $imap = $this->imap($user);
        $imap->command('DELETE ' . ImapClient::quote('Privat'));
        $imap->logout();
        self::assertTrue($this->sync($account));
        self::assertArrayNotHasKey('Privat', $this->folders($account));
        self::assertSame('drafts', $this->folders($account)['Entwürfe']['special_use']);
    }

    public function testConnectionErrorsBecomeAccountErrors(): void
    {
        $account = $this->account('fs-refused@example.org');
        Database::run(self::$db->pdo(), 'UPDATE mail_account SET imap_port = 3999 WHERE id = ?', [$account]);
        try {
            $this->sync($account);
            self::fail('expected an account error');
        } catch (AccountErrorException $e) {
            self::assertSame('CONNECTION_REFUSED', $e->errorCode);
        }
    }

    public function testDecodesModifiedUtf7(): void
    {
        self::assertSame('Gelöschte Elemente', ImapClient::decodeMailbox(ImapClient::encodeMailbox('Gelöschte Elemente')));
        self::assertSame([['\\HasNoChildren', '\\Sent'], '/', 'Sent Items'], ImapClient::tokens('(\\HasNoChildren \\Sent) "/" "Sent Items"'));
        self::assertSame([[], null, 'Odd "name"'], ImapClient::tokens("() NIL {11}\r\nOdd \"name\""));
    }
}
