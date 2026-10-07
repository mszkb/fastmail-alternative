<?php

declare(strict_types=1);

namespace Fma\Tests\Integration;

use Fma\Config;
use Fma\Crypto\Envelope;
use Fma\Db\Database;
use Fma\Db\Uuid;
use Fma\Jobs\Deadline;
use Fma\Jobs\DraftSyncJob;
use Fma\Jobs\Job;
use Fma\Jobs\JobQueue;
use Fma\Jobs\SendMessageJob;
use Fma\Jobs\SendRetryException;
use Fma\Log\Logger;
use Fma\Mail\HostConfig;
use Fma\Mail\ImapAppend;
use Fma\Mail\ImapClient;
use Fma\Mail\TransportPolicy;
use Fma\Mail\Uploads;
use Fma\Tests\Support\Http;

/** send_message and draft_sync against GreenMail (GREENMAIL_HOST, SMTP 3025, IMAP 3143, any login accepted). */
final class SendMessageTest extends DatabaseTestCase
{
    private string $greenmail = '';
    private string $masterKey;
    private TransportPolicy $policy;
    private string $dek = '';
    private string $user = '';

    protected function setUp(): void
    {
        $host = getenv('GREENMAIL_HOST');
        if (!\is_string($host) || $host === '') {
            self::markTestSkipped('GREENMAIL_HOST not set');
        }
        $this->greenmail = $host;
        $this->masterKey = base64_encode(random_bytes(32));
        $this->policy = new TransportPolicy(allowPrivateHosts: true, insecureTransport: true);
        self::$db->pdo()->exec('DELETE FROM job');
    }

    private function account(int $smtpPort = 3025): string
    {
        $pdo = self::$db->pdo();
        $this->user = 'send-' . bin2hex(random_bytes(4)) . '@example.org';
        $userId = Uuid::v4();
        Database::run($pdo, 'INSERT INTO `user` (id, email, password_hash) VALUES (?, ?, ?)', [$userId, "{$this->user}.owner", 'x']);
        $id = Uuid::v4();
        $this->dek = Envelope::generateDataKey();
        Database::run(
            $pdo,
            'INSERT INTO mail_account (id, user_id, display_name, email_address, imap_host, imap_port, smtp_host, smtp_port, wrapped_dek, key_id, credential_enc)
             VALUES (?, ?, ?, ?, ?, 3143, ?, ?, ?, ?, ?)',
            [$id, $userId, 'Me', $this->user, $this->greenmail, $this->greenmail, $smtpPort, Envelope::wrapDataKey(Envelope::loadMasterKey($this->masterKey), $this->dek, 'v1'), 'v1',
                Envelope::encryptField($this->dek, json_encode(['imapUser' => $this->user, 'imapPassword' => 'pw'], JSON_THROW_ON_ERROR), Envelope::credentialAad($id))],
        );
        $imap = $this->imap($this->user);
        foreach (['Sent' => 'sent', 'Drafts' => 'drafts'] as $path => $role) {
            $imap->command('CREATE ' . ImapClient::quote($path));
            Database::run($pdo, 'INSERT INTO folder (id, account_id, path, delimiter, special_use) VALUES (?, ?, ?, ?, ?)', [Uuid::v4(), $id, $path, '.', $role]);
        }
        $imap->logout();

        return $id;
    }

    private function imap(string $user): ImapClient
    {
        return ImapClient::connect($this->policy, new HostConfig($this->greenmail, 3143, false, $user, 'pw'));
    }

    /** @return list<string> raw messages of a folder */
    private function messages(string $user, string $path): array
    {
        $imap = $this->imap($user);
        $actions = new ImapAppend($imap);
        $actions->select($path);
        $result = [];
        foreach ($imap->command('UID SEARCH ALL') as $line) {
            foreach (\array_slice(preg_split('/\s+/', trim($line)) ?: [], 2) as $uid) {
                $fetched = implode("\n", $imap->command("UID FETCH {$uid} (FLAGS BODY.PEEK[])"));
                $result[] = $fetched;
            }
        }
        $imap->logout();

        return $result;
    }

    private function config(): Config
    {
        return Config::fromArray(['MASTER_KEY' => $this->masterKey]);
    }

    private function sendJob(): SendMessageJob
    {
        return new SendMessageJob(self::$db, $this->config(), new JobQueue(self::$db), new Logger('worker', 'info', Http::memoryStream()), $this->policy);
    }

    private function outbox(string $accountId, string $recipient, int $attachmentCount = 0): string
    {
        $id = Uuid::v4();
        $content = [
            'from' => ['name' => 'Jörg Me', 'address' => $this->user],
            'to' => [['name' => 'Empfänger', 'address' => $recipient]],
            'cc' => [], 'bcc' => [['name' => '', 'address' => 'hidden-' . $recipient]],
            'subject' => 'Grüße aus PHP', 'text' => "Hallo\n.\nZeile mit Umlaut ä",
        ];
        Database::run(
            self::$db->pdo(),
            "INSERT INTO outbox_message (id, account_id, status, content_enc, message_id_header, `references`, attachment_count)
             VALUES (?, ?, 'queued', ?, ?, '[\"<root@example.org>\"]', ?)",
            [$id, $accountId, Envelope::encryptField($this->dek, json_encode($content, JSON_THROW_ON_ERROR), Envelope::outboxContentAad($id)), "<{$id}@example.org>", $attachmentCount],
        );

        return $id;
    }

    public function testSendsStoresSentCopyAndClearsContent(): void
    {
        $accountId = $this->account();
        $recipient = 'rcpt-' . bin2hex(random_bytes(4)) . '@example.org';
        $outboxId = $this->outbox($accountId, $recipient, 1);
        Uploads::insert(self::$db->pdo(), $this->dek, $accountId, 'Bericht ä.pdf', 'application/pdf', '%PDF-1', null);
        Database::run(self::$db->pdo(), 'UPDATE attachment_upload SET outbox_id = ? WHERE account_id = ?', [$outboxId, $accountId]);

        self::assertTrue($this->sendJob()->run(new Job('1', 'send_message', $accountId, ['outboxId' => $outboxId], 1), new Deadline(30)));

        /** @var array{status: string, sent_copy: string, content_enc: ?string, sent_at: ?string, attempts: int|string} $row */
        $row = Database::run(self::$db->pdo(), 'SELECT status, sent_copy, content_enc, sent_at, attempts FROM outbox_message WHERE id = ?', [$outboxId])->fetch();
        self::assertSame(['sent', 'done', null, 1], [$row['status'], $row['sent_copy'], $row['content_enc'], (int) $row['attempts']]);
        self::assertNotNull($row['sent_at']);
        self::assertSame(0, (int) Database::run(self::$db->pdo(), 'SELECT COUNT(*) FROM attachment_upload')->fetchColumn());
        self::assertSame(1, (int) Database::run(self::$db->pdo(), "SELECT COUNT(*) FROM job WHERE type = 'message_sync'")->fetchColumn());

        $inbox = $this->messages($recipient, 'INBOX');
        self::assertCount(1, $inbox);
        self::assertStringContainsString("Message-ID: <{$outboxId}@example.org>", $inbox[0]);
        self::assertStringContainsString('References: <root@example.org>', $inbox[0]);
        self::assertStringContainsString('Subject: =?UTF-8?B?' . base64_encode('Grüße aus PHP') . '?=', $inbox[0]);
        self::assertStringNotContainsString('Bcc:', $inbox[0]);
        self::assertStringContainsString("filename*=UTF-8''Bericht%20%C3%A4.pdf", $inbox[0]);
        self::assertStringContainsString(base64_encode('%PDF-1'), $inbox[0]);
        self::assertCount(1, $this->messages('hidden-' . $recipient, 'INBOX'), 'bcc delivered');
        $sent = $this->messages($this->user, 'Sent');
        self::assertCount(1, $sent);
        self::assertStringContainsString('Bcc: hidden-' . $recipient, $sent[0]);
        self::assertStringContainsString('\Seen', $sent[0]);

        // A duplicate job does nothing.
        self::assertFalse($this->sendJob()->run(new Job('2', 'send_message', $accountId, ['outboxId' => $outboxId], 1), new Deadline(30)));
    }

    public function testMissingAttachmentAndConnectionErrors(): void
    {
        $accountId = $this->account();
        $outboxId = $this->outbox($accountId, 'x@example.org', 1);
        self::assertFalse($this->sendJob()->run(new Job('1', 'send_message', $accountId, ['outboxId' => $outboxId], 1), new Deadline(30)));
        self::assertSame(['failed', 'ATTACHMENT_MISSING'], ((array) Database::run(self::$db->pdo(), 'SELECT status, last_error_code FROM outbox_message WHERE id = ?', [$outboxId])->fetch(\PDO::FETCH_NUM)));

        $refused = $this->account(1);
        $outboxId = $this->outbox($refused, 'x@example.org');
        try {
            $this->sendJob()->run(new Job('1', 'send_message', $refused, ['outboxId' => $outboxId], 1), new Deadline(30));
            self::fail('retry expected');
        } catch (SendRetryException $e) {
            self::assertSame('CONNECTION_REFUSED', $e->errorCode);
        }
        self::assertSame(['queued', 'CONNECTION_REFUSED'], ((array) Database::run(self::$db->pdo(), 'SELECT status, last_error_code FROM outbox_message WHERE id = ?', [$outboxId])->fetch(\PDO::FETCH_NUM)));
        // Last attempt: failed for good.
        self::assertFalse($this->sendJob()->run(new Job('1', 'send_message', $refused, ['outboxId' => $outboxId], JobQueue::MAX_ATTEMPTS), new Deadline(30)));
        self::assertSame('failed', Database::run(self::$db->pdo(), 'SELECT status FROM outbox_message WHERE id = ?', [$outboxId])->fetchColumn());
    }

    public function testDraftSyncUploadsReplacesAndRemovesTheCopy(): void
    {
        $accountId = $this->account();
        $draftId = Uuid::v4();
        $content = ['to' => 'Anna <anna@example.org>, kaputt', 'cc' => '', 'bcc' => 'b@example.org', 'subject' => 'Entwurf', 'text' => 'Text'];
        $pdo = self::$db->pdo();
        Database::run(
            $pdo,
            'INSERT INTO draft (id, account_id, content_enc, version, imap_version) VALUES (?, ?, ?, 1, 0)',
            [$draftId, $accountId, Envelope::encryptField($this->dek, json_encode($content, JSON_THROW_ON_ERROR), Envelope::draftContentAad($draftId))],
        );
        $job = new DraftSyncJob(self::$db, $this->config(), new JobQueue(self::$db), $this->policy);
        $run = fn(): bool => $job->run(new Job('1', 'draft_sync', $accountId, ['draftId' => $draftId], 1), new Deadline(30));

        self::assertTrue($run());
        $copies = $this->messages($this->user, 'Drafts');
        self::assertCount(1, $copies);
        self::assertStringContainsString("<{$draftId}.1@example.org>", $copies[0]);
        self::assertStringContainsString('To: Anna <anna@example.org>', $copies[0]);
        self::assertStringContainsString('Bcc: b@example.org', $copies[0]);
        self::assertStringContainsString('\Draft', $copies[0]);
        self::assertFalse($run(), 'up to date');

        Database::run($pdo, 'UPDATE draft SET version = 2 WHERE id = ?', [$draftId]);
        self::assertTrue($run());
        $copies = $this->messages($this->user, 'Drafts');
        self::assertCount(1, $copies);
        self::assertStringContainsString("<{$draftId}.2@example.org>", $copies[0]);
        self::assertSame("<{$draftId}.2@example.org>", Database::run($pdo, 'SELECT message_id_header FROM draft WHERE id = ?', [$draftId])->fetchColumn());

        Database::run($pdo, 'UPDATE draft SET deleted_at = UTC_TIMESTAMP(6), content_enc = NULL WHERE id = ?', [$draftId]);
        self::assertTrue($run());
        self::assertSame([], $this->messages($this->user, 'Drafts'));
        self::assertFalse(Database::run($pdo, 'SELECT 1 FROM draft WHERE id = ?', [$draftId])->fetchColumn());
    }
}
