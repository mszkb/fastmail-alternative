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

final class ReadApiTest extends DatabaseTestCase
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
        $this->dataDir = sys_get_temp_dir() . '/fma-read-' . bin2hex(random_bytes(4));
        mkdir($this->dataDir);
        $config = Config::fromArray(['DATABASE_URL' => self::$config->get('DATABASE_URL'), 'MASTER_KEY' => $this->masterKey, 'MAIL_DATA_DIR' => $this->dataDir]);
        $this->app = App::create($config, self::$db, new Logger('api', 'info', Http::memoryStream()), [], new FakeConnectionTester());
        $this->userId = Uuid::v4();
        Database::run($pdo, 'INSERT INTO `user` (id, email, password_hash) VALUES (?, ?, ?)', [$this->userId, 'me@example.org', 'unused']);
        $this->token = (new Sessions(self::$db))->createDeviceWithSession($this->userId, 'Test', 'desktop');
        $this->accountId = Uuid::v4();
        $this->dek = Envelope::generateDataKey();
        Database::run(
            $pdo,
            "INSERT INTO mail_account (id, user_id, display_name, email_address, imap_host, imap_port, smtp_host, smtp_port, wrapped_dek, key_id, credential_enc)
             VALUES (?, ?, 'Me', 'me@example.org', 'imap.example.org', 993, 'smtp.example.org', 587, ?, 'v1', 'x')",
            [$this->accountId, $this->userId, Envelope::wrapDataKey(Envelope::loadMasterKey($this->masterKey), $this->dek, 'v1')],
        );
    }

    protected function tearDown(): void
    {
        foreach (glob($this->dataDir . '/*') ?: [] as $file) {
            unlink($file);
        }
        rmdir($this->dataDir);
    }

    /** @param array<mixed>|null $body */
    private function call(string $method, string $path, ?array $body = null): ResponseInterface
    {
        $request = Http::request($method, $path, ['Sec-Fetch-Site' => 'same-origin'])->withCookieParams(['fma_session' => $this->token]);
        if ($body !== null) {
            $request->getBody()->write(json_encode($body, JSON_THROW_ON_ERROR));
            $request = $request->withHeader('Content-Type', 'application/json');
        }
        $query = parse_url($path, PHP_URL_QUERY);
        if (\is_string($query)) {
            parse_str($query, $params);
            $request = $request->withQueryParams($params);
        }

        return $this->app->handle($request);
    }

    private function folder(string $path, ?string $specialUse = null, ?string $detected = null): string
    {
        $id = Uuid::v4();
        Database::run(
            self::$db->pdo(),
            'INSERT INTO folder (id, account_id, path, delimiter, special_use, special_use_detected) VALUES (?, ?, ?, ?, ?, ?)',
            [$id, $this->accountId, $path, '/', $specialUse, $detected ?? $specialUse],
        );

        return $id;
    }

    /** @param list<string> $flags */
    private function message(string $folderId, int $uid, string $subject, string $sentAt, array $flags = [], ?string $raw = null, ?string $threadId = null): string
    {
        $id = Uuid::v4();
        $enc = function (string $field, string $value) use ($id): string {
            \assert(\in_array($field, ['subject', 'from', 'recipients', 'snippet', 'text'], true));

            return Envelope::encryptField($this->dek, $value, Envelope::messageFieldAad($field, $id));
        };
        $pdo = self::$db->pdo();
        Database::run(
            $pdo,
            'INSERT INTO message (id, account_id, message_id_header, subject_enc, from_enc, recipients_enc, snippet_enc, sent_at, thread_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
                $id, $this->accountId, "<{$id}@example.org>", $enc('subject', $subject),
                $enc('from', '[{"name":"Anna","address":"anna@example.org"}]'),
                $enc('recipients', '{"to":[{"name":"","address":"me@example.org"}],"cc":[]}'),
                $enc('snippet', 'Hallo'), $sentAt, $threadId,
            ],
        );
        $locationId = Uuid::v4();
        Database::run($pdo, 'INSERT INTO message_location (id, message_id, folder_id, uidvalidity, uid) VALUES (?, ?, ?, 1, ?)', [$locationId, $id, $folderId, $uid]);
        foreach ($flags as $flag) {
            Database::run($pdo, 'INSERT INTO message_flag (location_id, flag) VALUES (?, ?)', [$locationId, $flag]);
        }
        $storageRef = null;
        if ($raw !== null) {
            $storageRef = "{$id}.eml";
            file_put_contents("{$this->dataDir}/{$storageRef}", Envelope::encryptBytes($this->dek, $raw, Envelope::messageFieldAad('body', $id)));
        }
        Database::run($pdo, 'INSERT INTO message_body (message_id, storage_ref, text_plain_enc) VALUES (?, ?, ?)', [$id, $storageRef, $enc('text', "Text {$subject}")]);

        return $id;
    }

    public function testFolderTreeAndRoles(): void
    {
        $inbox = $this->folder('INBOX');
        $sub = $this->folder('INBOX/Sub');
        $this->folder('Papierkorb', 'trash');
        $other = $this->folder('Other');
        $this->message($inbox, 1, 'A', '2026-10-01 10:00:00');
        $this->message($inbox, 2, 'B', '2026-10-02 10:00:00', ['\Seen']);

        $response = $this->call('GET', "/api/accounts/{$this->accountId}/folders");
        self::assertSame(200, $response->getStatusCode());
        $folders = Http::json($response)['folders'];
        \assert(\is_array($folders));
        self::assertSame(['INBOX', 'INBOX/Sub', 'Papierkorb', 'Other'], array_column($folders, 'path'));
        self::assertSame(['id' => $inbox, 'name' => 'INBOX', 'path' => 'INBOX', 'delimiter' => '/', 'parentId' => null, 'depth' => 0, 'specialUse' => 'inbox', 'specialUseOverride' => null, 'selectable' => true, 'unreadCount' => 1, 'total' => 2], $folders[0]);
        self::assertSame($inbox, $folders[1]['parentId']);
        self::assertSame('Sub', $folders[1]['name']);
        self::assertSame(404, $this->call('GET', '/api/accounts/' . Uuid::v4() . '/folders')->getStatusCode());

        self::assertSame(400, $this->call('PATCH', "/api/folders/{$other}", ['specialUse' => 'bogus'])->getStatusCode());
        self::assertSame(400, $this->call('PATCH', "/api/folders/{$inbox}", ['specialUse' => 'trash'])->getStatusCode());
        self::assertSame(204, $this->call('PATCH', "/api/folders/{$other}", ['specialUse' => 'trash'])->getStatusCode());
        $roles = Database::run(self::$db->pdo(), 'SELECT path, special_use FROM folder WHERE account_id = ? ORDER BY path', [$this->accountId])->fetchAll(\PDO::FETCH_KEY_PAIR);
        self::assertSame(['INBOX' => 'inbox', 'INBOX/Sub' => null, 'Other' => 'trash', 'Papierkorb' => null], $roles);
        self::assertSame(204, $this->call('PATCH', "/api/folders/{$other}", ['specialUse' => null])->getStatusCode());
        self::assertSame('trash', Database::run(self::$db->pdo(), "SELECT special_use FROM folder WHERE path = 'Papierkorb'")->fetchColumn());

        $first = $this->call('POST', "/api/folders/{$sub}/load-older");
        self::assertSame(202, $first->getStatusCode());
        self::assertSame(['queued' => true], Http::json($first));
        self::assertSame(['queued' => false], Http::json($this->call('POST', "/api/folders/{$sub}/load-older")));
    }

    public function testMessageListPagingDetailAndThread(): void
    {
        $inbox = $this->folder('INBOX');
        $threadId = Uuid::v4();
        Database::run(self::$db->pdo(), 'INSERT INTO thread (id, account_id) VALUES (?, ?)', [$threadId, $this->accountId]);
        $ids = [];
        for ($i = 1; $i <= 3; ++$i) {
            $ids[] = $this->message($inbox, $i, "S{$i}", "2026-10-0{$i} 10:00:00.123456", $i === 1 ? ['\Seen', '\Flagged'] : [], threadId: $i < 3 ? $threadId : null);
        }

        $page1 = Http::json($this->call('GET', "/api/folders/{$inbox}/messages?limit=2"));
        \assert(\is_array($page1['messages']));
        self::assertSame(['S3', 'S2'], array_column($page1['messages'], 'subject'));
        self::assertSame('2026-10-03T10:00:00.123Z', $page1['messages'][0]['date']);
        self::assertSame(['name' => 'Anna', 'address' => 'anna@example.org'], $page1['messages'][0]['from']);
        self::assertSame(2, $page1['messages'][1]['threadCount']);
        self::assertIsString($page1['nextCursor']);
        $page2 = Http::json($this->call('GET', "/api/folders/{$inbox}/messages?limit=2&cursor=" . $page1['nextCursor']));
        \assert(\is_array($page2['messages']));
        self::assertSame(['S1'], array_column($page2['messages'], 'subject'));
        self::assertSame(['seen' => true, 'flagged' => true, 'answered' => false], $page2['messages'][0]['flags']);
        self::assertNull($page2['nextCursor']);
        self::assertSame(400, $this->call('GET', "/api/folders/{$inbox}/messages?cursor=bogus")->getStatusCode());
        self::assertSame(400, $this->call('GET', "/api/folders/{$inbox}/messages?limit=0")->getStatusCode());

        $detail = Http::json($this->call('GET', "/api/messages/{$ids[0]}"));
        self::assertSame('S1', $detail['subject']);
        self::assertSame([$inbox], $detail['folderIds']);
        self::assertSame([['name' => '', 'address' => 'me@example.org']], $detail['to']);
        self::assertSame('Text S1', $detail['text']);
        self::assertSame("<{$ids[0]}@example.org>", $detail['messageId']);
        self::assertSame(404, $this->call('GET', '/api/messages/' . Uuid::v4())->getStatusCode());

        $thread = Http::json($this->call('GET', "/api/threads/{$threadId}"));
        \assert(\is_array($thread['messages']));
        self::assertSame(['S1', 'S2'], array_column($thread['messages'], 'subject'));
        self::assertSame('S2', $thread['subject']);

        self::assertSame(404, $this->call('GET', '/api/unified/inbox')->getStatusCode());
        Database::run(self::$db->pdo(), 'UPDATE `user` SET unified_inbox_enabled = TRUE WHERE id = ?', [$this->userId]);
        $unified = Http::json($this->call('GET', '/api/unified/inbox'));
        \assert(\is_array($unified['messages']));
        self::assertSame([$this->accountId, $inbox], [$unified['messages'][0]['accountId'], $unified['messages'][0]['folderId']]);
    }

    public function testActions(): void
    {
        $inbox = $this->folder('INBOX');
        $archive = $this->folder('Archiv', 'archive');
        $id = $this->message($inbox, 7, 'A', '2026-10-01 10:00:00');

        self::assertSame(400, $this->call('POST', '/api/messages/actions', ['folderId' => $inbox, 'messageIds' => [], 'action' => 'read'])->getStatusCode());
        self::assertSame(['updated' => 1], Http::json($this->call('POST', '/api/messages/actions', ['folderId' => $inbox, 'messageIds' => [$id], 'action' => 'read'])));
        self::assertSame(['\Seen'], Database::run(self::$db->pdo(), 'SELECT flag FROM message_flag')->fetchAll(\PDO::FETCH_COLUMN));
        $response = $this->call('POST', '/api/messages/actions', ['folderId' => $inbox, 'messageIds' => [$id], 'action' => 'delete']);
        self::assertSame(409, $response->getStatusCode());
        self::assertSame('Für dieses Konto gibt es keinen Papierkorb-Ordner.', Http::json($response)['message']);

        self::assertSame(200, $this->call('POST', '/api/messages/actions', ['folderId' => $inbox, 'messageIds' => [$id], 'action' => 'archive'])->getStatusCode());
        /** @var array{folder_id: string, uidvalidity: int, uid: int} $location */
        $location = Database::run(self::$db->pdo(), 'SELECT folder_id, uidvalidity, uid FROM message_location')->fetch();
        self::assertSame($archive, $location['folder_id']);
        self::assertSame(0, (int) $location['uidvalidity']);
        self::assertLessThan(0, (int) $location['uid']);
        $this->assertSame(409, $this->call('POST', '/api/messages/actions', ['folderId' => $archive, 'messageIds' => [$id], 'action' => 'unread'])->getStatusCode());

        $payloads = Database::run(self::$db->pdo(), "SELECT payload FROM job WHERE type = 'message_action' ORDER BY id")->fetchAll(\PDO::FETCH_COLUMN);
        self::assertCount(2, $payloads);
        $move = json_decode((string) $payloads[1], true);
        \assert(\is_array($move));
        // assertEquals: MySQL's JSON type does not keep the key order.
        self::assertEquals(['operation' => 'move', 'folderId' => $inbox, 'uidvalidity' => '1', 'items' => [['uid' => 7, 'locationId' => $move['items'][0]['locationId'], 'messageId' => $id]], 'targetFolderId' => $archive], $move);
    }

    public function testHtmlAndAttachments(): void
    {
        $inbox = $this->folder('INBOX');
        $png = base64_encode('PNGDATA');
        $raw = "From: a@example.org\r\nSubject: x\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"b1\"\r\n\r\n"
            . "--b1\r\nContent-Type: multipart/related; boundary=\"b2\"\r\n\r\n"
            . "--b2\r\nContent-Type: text/html; charset=utf-8\r\n\r\n"
            . '<html><body bgcolor="#fff"><p onclick="x()">Hi <img src="cid:logo@x"><img src="https://tracker.example/p.gif"></p><script>alert(1)</script><a href="javascript:alert(1)">l</a><style>p { background: url(http://x/y) }</style></body></html>'
            . "\r\n--b2\r\nContent-Type: image/png\r\nContent-ID: <logo@x>\r\nContent-Transfer-Encoding: base64\r\n\r\n{$png}\r\n--b2--\r\n"
            . "--b1\r\nContent-Type: text/html; name=\"evil.html\"\r\nContent-Disposition: attachment; filename=\"evil.html\"\r\n\r\n<script>x</script>\r\n--b1--\r\n";
        $id = $this->message($inbox, 1, 'A', '2026-10-01 10:00:00', raw: $raw);

        $response = $this->call('GET', "/api/messages/{$id}/html");
        self::assertSame('no-store', $response->getHeaderLine('Cache-Control'));
        $html = Http::json($response);
        self::assertTrue($html['remoteContentBlocked']);
        \assert(\is_string($html['html']));
        self::assertStringContainsString('<div style="background-color: #fff"><p>Hi <img src="data:image/png;base64,' . $png . '" referrerpolicy="no-referrer" />', $html['html']);
        self::assertStringNotContainsString('script', $html['html']);
        self::assertStringNotContainsString('tracker', $html['html']);
        self::assertStringContainsString('<a target="_blank" rel="noopener noreferrer nofollow">l</a>', $html['html']);
        self::assertStringContainsString('<style>p { background: none }</style>', $html['html']);
        $remote = Http::json($this->call('GET', "/api/messages/{$id}/html?remote=1"));
        self::assertFalse($remote['remoteContentBlocked']);
        self::assertStringContainsString('src="https://tracker.example/p.gif"', (string) $remote['html']);

        $list = Http::json($this->call('GET', "/api/messages/{$id}/attachments"));
        self::assertSame([
            ['index' => 0, 'filename' => 'anhang-1', 'contentType' => 'image/png', 'size' => 7, 'inline' => true],
            ['index' => 1, 'filename' => 'evil.html', 'contentType' => 'text/html', 'size' => 18, 'inline' => false],
        ], $list['attachments']);
        $file = $this->call('GET', "/api/messages/{$id}/attachments/1?inline=1");
        self::assertSame(200, $file->getStatusCode());
        self::assertSame('application/octet-stream', $file->getHeaderLine('Content-Type'));
        self::assertSame('attachment; filename="evil.html"; filename*=UTF-8\'\'evil.html', $file->getHeaderLine('Content-Disposition'));
        self::assertSame('nosniff', $file->getHeaderLine('X-Content-Type-Options'));
        self::assertSame('<script>x</script>', (string) $file->getBody());
        $image = $this->call('GET', "/api/messages/{$id}/attachments/0?inline=1");
        self::assertSame('image/png', $image->getHeaderLine('Content-Type'));
        self::assertStringStartsWith('inline;', $image->getHeaderLine('Content-Disposition'));
        self::assertSame(404, $this->call('GET', "/api/messages/{$id}/attachments/2")->getStatusCode());
        self::assertSame(404, $this->call('GET', '/api/messages/' . Uuid::v4() . '/attachments')->getStatusCode());

        $noRaw = $this->message($inbox, 2, 'B', '2026-10-01 10:00:00');
        self::assertSame(['html' => null, 'remoteContentBlocked' => false], Http::json($this->call('GET', "/api/messages/{$noRaw}/html")));
        self::assertSame(['attachments' => []], Http::json($this->call('GET', "/api/messages/{$noRaw}/attachments")));
    }
}
