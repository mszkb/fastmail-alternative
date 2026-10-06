<?php

declare(strict_types=1);

namespace Fma\Tests\Integration;

use Fma\App;
use Fma\Auth\Sessions;
use Fma\Config;
use Fma\Crypto\Envelope;
use Fma\Db\Database;
use Fma\Db\Uuid;
use Fma\Log\Logger;
use Fma\Tests\Support\FakeConnectionTester;
use Fma\Tests\Support\Http;
use Psr\Http\Message\ResponseInterface;

/** Outbox, drafts, uploads and attachment copies (#105), like apps/api's outbox/drafts/attachments tests. */
final class ComposeTest extends DatabaseTestCase
{
    /** @var \Slim\App<\Psr\Container\ContainerInterface|null> */
    private \Slim\App $app;
    private string $masterKey;
    private string $userId;
    private string $token;
    private string $accountId;
    private string $dek;
    private string $dataDir;

    protected function setUp(): void
    {
        $pdo = self::$db->pdo();
        foreach (['job', 'mail_account', '`user`'] as $table) {
            $pdo->exec("DELETE FROM {$table}");
        }
        $this->masterKey = base64_encode(random_bytes(32));
        $this->dataDir = sys_get_temp_dir() . '/fma-compose-' . bin2hex(random_bytes(4));
        mkdir($this->dataDir);
        $config = Config::fromArray([
            'DATABASE_URL' => self::$config->get('DATABASE_URL'), 'MASTER_KEY' => $this->masterKey, 'MAIL_DATA_DIR' => $this->dataDir,
            'MAX_ATTACHMENT_BYTES' => '1000', 'MAX_ATTACHMENTS_TOTAL_BYTES' => '1500',
        ]);
        $this->app = App::create($config, self::$db, new Logger('api', 'info', Http::memoryStream()), [], new FakeConnectionTester());
        $this->userId = Uuid::v4();
        Database::run($pdo, 'INSERT INTO `user` (id, email, password_hash) VALUES (?, ?, ?)', [$this->userId, 'me@example.org', 'unused']);
        $this->token = (new Sessions(self::$db))->createDeviceWithSession($this->userId, 'Test', 'desktop');
        $this->accountId = $this->account($this->userId);
    }

    protected function tearDown(): void
    {
        foreach (glob($this->dataDir . '/*') ?: [] as $file) {
            unlink($file);
        }
        rmdir($this->dataDir);
    }

    private function account(string $userId): string
    {
        $id = Uuid::v4();
        $this->dek = Envelope::generateDataKey();
        Database::run(
            self::$db->pdo(),
            "INSERT INTO mail_account (id, user_id, display_name, email_address, imap_host, imap_port, smtp_host, smtp_port, wrapped_dek, key_id, credential_enc)
             VALUES (?, ?, 'Me', 'me@example.org', 'imap.example.org', 993, 'smtp.example.org', 587, ?, 'v1', 'x')",
            [$id, $userId, Envelope::wrapDataKey(Envelope::loadMasterKey($this->masterKey), $this->dek, 'v1')],
        );

        return $id;
    }

    /**
     * @param array<mixed>|null $body
     * @param array<string, string> $headers
     */
    private function call(string $method, string $path, ?array $body = null, ?string $raw = null, array $headers = []): ResponseInterface
    {
        $request = Http::request($method, $path, ['Sec-Fetch-Site' => 'same-origin'] + $headers)->withCookieParams(['fma_session' => $this->token]);
        if ($body !== null) {
            $request->getBody()->write(json_encode($body, JSON_THROW_ON_ERROR));
            $request = $request->withHeader('Content-Type', 'application/json');
        }
        if ($raw !== null) {
            $request->getBody()->write($raw);
        }

        return $this->app->handle($request);
    }

    /** @return array<mixed> */
    private function json(ResponseInterface $response, int $status): array
    {
        self::assertSame($status, $response->getStatusCode(), (string) $response->getBody());

        return Http::json($response);
    }

    /** @return list<array{type: string, payload: string, run_at: string}> */
    private function jobs(string $type): array
    {
        /** @var list<array{type: string, payload: string, run_at: string}> */
        return Database::run(self::$db->pdo(), 'SELECT type, payload, run_at FROM job WHERE type = ? ORDER BY id', [$type])->fetchAll();
    }

    private function upload(string $name = 'Bericht ä.txt', string $content = 'hello'): string
    {
        $data = $this->json($this->call('POST', "/api/accounts/{$this->accountId}/uploads", raw: $content, headers: [
            'Content-Type' => 'application/octet-stream', 'X-Filename' => rawurlencode($name), 'X-Content-Type' => 'text/plain; charset=utf-8',
        ]), 201);
        \assert(\is_string($data['id']));

        return $data['id'];
    }

    public function testSendValidatesStoresEncryptedAndQueues(): void
    {
        self::assertSame(['message' => 'Ungültiges Konto.'], $this->json($this->call('POST', '/api/outbox', ['accountId' => 'x']), 400));
        $base = ['accountId' => $this->accountId, 'subject' => 'Hallo', 'text' => 'Text'];
        self::assertSame(['message' => 'Mindestens ein Empfänger ist erforderlich.'], $this->json($this->call('POST', '/api/outbox', $base), 400));
        self::assertSame(['message' => 'Ungültige Empfängeradresse.'], $this->json($this->call('POST', '/api/outbox', $base + ['to' => ['kaputt']]), 400));
        self::assertSame(['message' => 'Ungültiger In-Reply-To-Header.'], $this->json($this->call('POST', '/api/outbox', $base + ['to' => ['a@example.org'], 'inReplyTo' => 'x']), 400));
        self::assertSame(['message' => 'Konto nicht gefunden.'], $this->json($this->call('POST', '/api/outbox', ['accountId' => Uuid::v4()] + $base + ['to' => ['a@example.org']]), 404));

        $clientId = Uuid::v4();
        $request = $base + ['to' => ['a@example.org', ['name' => "Bob\r\nX", 'address' => 'b@example.org']], 'clientId' => $clientId, 'references' => ['<r@x>']];
        $sent = $this->json($this->call('POST', '/api/outbox', $request), 201);
        self::assertSame('queued', $sent['status']);
        self::assertSame('Hallo', $sent['subject']);
        self::assertSame(['name' => 'Me', 'address' => 'me@example.org'], $sent['from']);
        self::assertSame([['name' => '', 'address' => 'a@example.org'], ['name' => 'Bob X', 'address' => 'b@example.org']], $sent['to']);
        self::assertMatchesRegularExpression('/^<[0-9a-f-]{36}@example\.org>$/', (string) $sent['messageId']);
        self::assertNull($sent['error']);
        self::assertNull($sent['sentAt']);
        $stored = Database::run(self::$db->pdo(), 'SELECT content_enc FROM outbox_message WHERE id = ?', [$sent['id']])->fetchColumn();
        self::assertIsString($stored);
        self::assertStringNotContainsString('Hallo', $stored);
        self::assertCount(1, $this->jobs('send_message'));

        // Idempotent repeat: same entry, no second job.
        self::assertSame($sent['id'], $this->json($this->call('POST', '/api/outbox', $request), 200)['id']);
        self::assertCount(1, $this->jobs('send_message'));

        self::assertSame($sent['id'], $this->json($this->call('GET', "/api/outbox/{$sent['id']}"), 200)['id']);
        self::assertCount(1, $this->json($this->call('GET', "/api/accounts/{$this->accountId}/outbox"), 200)['messages']);
        self::assertSame(409, $this->call('POST', "/api/outbox/{$sent['id']}/retry")->getStatusCode());
        Database::run(self::$db->pdo(), "UPDATE outbox_message SET status = 'failed', last_error_code = 'SMTP_REJECTED' WHERE id = ?", [$sent['id']]);
        $failed = $this->json($this->call('GET', "/api/outbox/{$sent['id']}"), 200);
        self::assertSame(['code' => 'SMTP_REJECTED', 'message' => 'Der SMTP-Server hat die Nachricht abgelehnt (z. B. Empfänger unbekannt).'], $failed['error']);
        $retried = $this->json($this->call('POST', "/api/outbox/{$sent['id']}/retry"), 200);
        self::assertSame('queued', $retried['status']);
        self::assertCount(2, $this->jobs('send_message'));

        // Foreign entries are 404.
        $this->token = (new Sessions(self::$db))->createDeviceWithSession($this->otherUser(), 'Other', 'desktop');
        self::assertSame(404, $this->call('GET', "/api/outbox/{$sent['id']}")->getStatusCode());
        self::assertSame(404, $this->call('GET', "/api/accounts/{$this->accountId}/outbox")->getStatusCode());
    }

    private function otherUser(): string
    {
        $id = Uuid::v4();
        Database::run(self::$db->pdo(), 'INSERT INTO `user` (id, email, password_hash) VALUES (?, ?, ?)', [$id, 'other@example.org', 'unused']);

        return $id;
    }

    public function testUploadsAndAttachmentsOfASentMessage(): void
    {
        $headers = ['Content-Type' => 'application/octet-stream', 'X-Filename' => 'a.txt'];
        self::assertSame(415, $this->call('POST', "/api/accounts/{$this->accountId}/uploads", raw: 'x', headers: ['Content-Type' => 'text/plain'])->getStatusCode());
        self::assertSame(['message' => 'Die Datei ist zu groß (höchstens 1000 B).'], $this->json($this->call('POST', "/api/accounts/{$this->accountId}/uploads", raw: str_repeat('x', 1001), headers: $headers), 413));
        self::assertSame(400, $this->call('POST', "/api/accounts/{$this->accountId}/uploads", raw: 'x', headers: ['X-Filename' => '%zz'] + $headers)->getStatusCode());
        self::assertSame(404, $this->call('POST', '/api/accounts/' . Uuid::v4() . '/uploads', raw: 'x', headers: $headers)->getStatusCode());

        $response = $this->call('POST', "/api/accounts/{$this->accountId}/uploads", raw: 'hello', headers: ['X-Filename' => rawurlencode('../Bericht ä.txt'), 'X-Content-Type' => 'TEXT/Plain; charset=utf-8'] + $headers);
        $upload = $this->json($response, 201);
        self::assertSame(['filename' => 'Bericht ä.txt', 'contentType' => 'text/plain', 'size' => 5], ['filename' => $upload['filename'], 'contentType' => $upload['contentType'], 'size' => $upload['size']]);
        /** @var array{filename_enc: string, content_enc: string} $row */
        $row = Database::run(self::$db->pdo(), 'SELECT filename_enc, content_enc FROM attachment_upload WHERE id = ?', [$upload['id']])->fetch();
        self::assertStringNotContainsString('Bericht', $row['filename_enc']);

        $second = $this->upload('b.bin', str_repeat('y', 900));
        $missing = Uuid::v4();
        $base = ['accountId' => $this->accountId, 'to' => ['a@example.org'], 'subject' => 'S', 'text' => 'T'];
        $gone = $this->json($this->call('POST', '/api/outbox', $base + ['attachmentIds' => [$upload['id'], $missing]]), 410);
        self::assertSame(['code' => 'ATTACHMENT_MISSING', 'message' => 'Ein Anhang ist nicht mehr vorhanden (abgelaufen oder entfernt). Bitte erneut hinzufügen.', 'missingIds' => [$missing]], $gone);
        $third = $this->upload('c.bin', str_repeat('z', 900));
        self::assertSame(['message' => 'Die Anhänge sind zusammen zu groß (höchstens 1,5 KB).'], $this->json($this->call('POST', '/api/outbox', $base + ['attachmentIds' => [$second, $third]]), 413));
        self::assertSame(0, (int) Database::run(self::$db->pdo(), 'SELECT COUNT(*) FROM outbox_message')->fetchColumn());

        $sent = $this->json($this->call('POST', '/api/outbox', $base + ['attachmentIds' => [$upload['id'], $second]]), 201);
        self::assertSame(2, (int) Database::run(self::$db->pdo(), 'SELECT COUNT(*) FROM attachment_upload WHERE outbox_id = ?', [$sent['id']])->fetchColumn());
        // Attached uploads cannot be deleted any more; free ones can.
        self::assertSame(404, $this->call('DELETE', "/api/uploads/{$second}")->getStatusCode());
        self::assertSame(204, $this->call('DELETE', "/api/uploads/{$third}")->getStatusCode());
        self::assertSame(404, $this->call('DELETE', "/api/uploads/{$third}")->getStatusCode());
    }

    public function testDraftLifecycle(): void
    {
        $id = Uuid::v4();
        $body = ['accountId' => $this->accountId, 'to' => 'Anna <anna@example.org>, kaputt', 'cc' => '', 'bcc' => '', 'subject' => "Ent\nwurf", 'text' => 'Hallo'];
        self::assertSame(['message' => 'Ungültige Version.'], $this->json($this->call('PUT', "/api/drafts/{$id}", $body + ['baseVersion' => -1]), 400));
        self::assertSame(404, $this->call('PUT', '/api/drafts/nope', $body)->getStatusCode());

        $created = $this->json($this->call('PUT', "/api/drafts/{$id}", $body), 201);
        self::assertSame(1, $created['version']);
        self::assertSame('Ent wurf', $created['subject']);
        self::assertSame('Anna <anna@example.org>, kaputt', $created['to']);
        self::assertSame([], $created['attachments']);
        self::assertCount(1, $this->jobs('draft_sync'));

        $updated = $this->json($this->call('PUT', "/api/drafts/{$id}", ['text' => 'Neu', 'baseVersion' => 1] + $body), 200);
        self::assertSame(2, $updated['version']);
        self::assertSame('Neu', $updated['text']);
        self::assertCount(1, $this->jobs('draft_sync'), 'coalesced');

        $conflict = $this->json($this->call('PUT', "/api/drafts/{$id}", ['text' => 'Alt', 'baseVersion' => 1] + $body), 409);
        self::assertSame('Der Entwurf wurde inzwischen auf einem anderen Gerät geändert.', $conflict['message']);
        \assert(\is_array($conflict['draft']));
        self::assertSame('Neu', $conflict['draft']['text']);
        self::assertSame(3, $this->json($this->call('PUT', "/api/drafts/{$id}", ['baseVersion' => 1, 'force' => true] + $body), 200)['version']);

        $upload = $this->upload();
        $withFile = $this->json($this->call('PUT', "/api/drafts/{$id}", ['baseVersion' => 3, 'attachmentIds' => [$upload, Uuid::v4()]] + $body), 200);
        \assert(\is_array($withFile['attachments']));
        self::assertSame([['id' => $upload, 'filename' => 'Bericht ä.txt', 'contentType' => 'text/plain', 'size' => 5]], $withFile['attachments']);

        self::assertSame($id, $this->json($this->call('GET', "/api/drafts/{$id}"), 200)['id']);
        $list = $this->json($this->call('GET', "/api/accounts/{$this->accountId}/drafts"), 200);
        self::assertSame([$id], array_column(\is_array($list['drafts']) ? $list['drafts'] : [], 'id'));

        $discarded = $this->call('DELETE', "/api/drafts/{$id}");
        $again = $this->call('DELETE', "/api/drafts/{$id}");
        self::assertSame([204, 204], [$discarded->getStatusCode(), $again->getStatusCode()]);
        self::assertSame(404, $this->call('GET', "/api/drafts/{$id}")->getStatusCode());
        self::assertSame(0, (int) Database::run(self::$db->pdo(), 'SELECT COUNT(*) FROM attachment_upload')->fetchColumn());
        self::assertSame(['message' => 'Der Entwurf wurde inzwischen gesendet oder verworfen.'], $this->json($this->call('PUT', "/api/drafts/{$id}", ['baseVersion' => 4] + $body), 410));

        // Sending a draft deletes it and moves its uploads to the message.
        $second = Uuid::v4();
        $upload = $this->upload();
        $this->json($this->call('PUT', "/api/drafts/{$second}", $body + ['attachmentIds' => [$upload]]), 201);
        $sent = $this->json($this->call('POST', '/api/outbox', ['accountId' => $this->accountId, 'to' => ['anna@example.org'], 'subject' => 'S', 'text' => 'T', 'draftId' => $second, 'attachmentIds' => [$upload]]), 201);
        self::assertSame(404, $this->call('GET', "/api/drafts/{$second}")->getStatusCode());
        self::assertSame($sent['id'], Database::run(self::$db->pdo(), 'SELECT outbox_id FROM attachment_upload WHERE id = ?', [$upload])->fetchColumn());
        self::assertNull(Database::run(self::$db->pdo(), 'SELECT draft_id FROM attachment_upload WHERE id = ?', [$upload])->fetchColumn());
    }

    private function storedMessage(string $folderPath, ?string $specialUse, string $raw, string $messageIdHeader): string
    {
        $pdo = self::$db->pdo();
        $folderId = Uuid::v4();
        Database::run($pdo, 'INSERT INTO folder (id, account_id, path, delimiter, special_use, uidvalidity) VALUES (?, ?, ?, ?, ?, 7)', [$folderId, $this->accountId, $folderPath, '/', $specialUse]);
        $id = Uuid::v4();
        $enc = fn(string $field, string $value): string => Envelope::encryptField($this->dek, $value, Envelope::messageFieldAad($field === 'subject' ? 'subject' : ($field === 'recipients' ? 'recipients' : 'text'), $id));
        Database::run(
            $pdo,
            'INSERT INTO message (id, account_id, message_id_header, subject_enc, from_enc, recipients_enc, snippet_enc, sent_at, has_attachments)
             VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), 1)',
            [$id, $this->accountId, $messageIdHeader, $enc('subject', 'Alter Entwurf'), 'x', $enc('recipients', '{"to":[{"name":"Doe, John","address":"j@example.org"}],"cc":[]}'), 'x'],
        );
        Database::run($pdo, 'INSERT INTO message_location (id, message_id, folder_id, uidvalidity, uid) VALUES (?, ?, ?, 7, 42)', [Uuid::v4(), $id, $folderId]);
        file_put_contents("{$this->dataDir}/{$id}.eml", Envelope::encryptBytes($this->dek, $raw, Envelope::messageFieldAad('body', $id)));
        Database::run($pdo, 'INSERT INTO message_body (message_id, storage_ref, text_plain_enc) VALUES (?, ?, ?)', [$id, "{$id}.eml", $enc('text', 'Entwurfstext')]);

        return $id;
    }

    private const RAW = "From: a@example.org\r\nTo: j@example.org\r\nSubject: Alter Entwurf\r\nMIME-Version: 1.0\r\n"
        . "Content-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nEntwurfstext\r\n"
        . "--b\r\nContent-Type: application/pdf; name=a.pdf\r\nContent-Disposition: attachment; filename=a.pdf\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0x\r\n--b--\r\n";

    public function testCopyAttachmentsAndOpenMessageAsDraft(): void
    {
        $messageId = $this->storedMessage('Drafts', 'drafts', self::RAW, '<other@example.org>');
        self::assertSame(404, $this->call('POST', "/api/messages/{$messageId}/attachments/copy", ['accountId' => Uuid::v4()])->getStatusCode());
        $copy = $this->json($this->call('POST', "/api/messages/{$messageId}/attachments/copy", ['accountId' => $this->accountId]), 201);
        \assert(\is_array($copy['attachments']));
        self::assertSame(0, $copy['skipped']);
        self::assertCount(1, $copy['attachments']);
        self::assertSame(['filename' => 'a.pdf', 'contentType' => 'application/pdf', 'size' => 6], array_diff_key($copy['attachments'][0], ['id' => 1]));

        $draft = $this->json($this->call('POST', "/api/messages/{$messageId}/draft"), 201);
        self::assertSame('"Doe, John" <j@example.org>', $draft['to']);
        self::assertSame('Alter Entwurf', $draft['subject']);
        self::assertSame('Entwurfstext', $draft['text']);
        \assert(\is_array($draft['attachments']));
        self::assertCount(1, $draft['attachments']);
        self::assertArrayNotHasKey('attachmentsSkipped', $draft);
        /** @var array{keep_source: int|string, source_uid: int|string, imap_version: int|string} $row */
        $row = Database::run(self::$db->pdo(), 'SELECT keep_source, source_uid, imap_version FROM draft WHERE id = ?', [$draft['id']])->fetch();
        self::assertSame([0, 42, 1], [(int) $row['keep_source'], (int) $row['source_uid'], (int) $row['imap_version']]);
        // Opening again resumes the same draft.
        self::assertSame($draft['id'], $this->json($this->call('POST', "/api/messages/{$messageId}/draft"), 200)['id']);
        self::assertSame(404, $this->call('POST', '/api/messages/' . Uuid::v4() . '/draft')->getStatusCode());
    }
}
