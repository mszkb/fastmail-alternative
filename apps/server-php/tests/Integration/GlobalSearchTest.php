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
use Fma\Mail\HostConfig;
use Fma\Mail\ImapActions;
use Fma\Mail\ImapClient;
use Fma\Mail\TransportPolicy;
use Fma\Routes\MessageRoutes;
use Fma\Routes\SearchRoutes;
use Fma\Tests\Support\FakeConnectionTester;
use Fma\Tests\Support\Http;
use Psr\Http\Message\ResponseInterface;

/**
 * GET /api/search (#121) over three GreenMail accounts (GREENMAIL_HOST,
 * IMAP 3143).
 */
final class GlobalSearchTest extends DatabaseTestCase
{
    /** @var \Slim\App<\Psr\Container\ContainerInterface|null> */
    private \Slim\App $app;
    private string $greenmail = '';
    private string $masterKey;
    private string $userId;
    private string $token;
    private string $tag;
    /** @var resource */
    private $logStream;
    /** @var list<string> account ids in rail order */
    private array $accounts = [];
    /** @var array<string, string> account id => DEK */
    private array $deks = [];
    /** @var array<string, string> "account id/path" => folder id */
    private array $folders = [];

    protected function setUp(): void
    {
        $host = getenv('GREENMAIL_HOST');
        if (!\is_string($host) || $host === '') {
            self::markTestSkipped('GREENMAIL_HOST not set');
        }
        $this->greenmail = $host;
        $pdo = self::$db->pdo();
        foreach (['job', 'rate_limit', 'search_result', 'mail_account', '`user`'] as $table) {
            $pdo->exec("DELETE FROM {$table}");
        }
        $this->masterKey = base64_encode(random_bytes(32));
        $config = Config::fromArray([
            'DATABASE_URL' => self::$config->get('DATABASE_URL'),
            'MASTER_KEY' => $this->masterKey,
            'MAIL_ALLOW_PRIVATE_HOSTS' => '1',
            'MAIL_INSECURE_TRANSPORT' => '1',
        ]);
        $this->logStream = Http::memoryStream();
        $this->app = App::create($config, self::$db, new Logger('api', 'info', $this->logStream), [], new FakeConnectionTester());
        $this->userId = Uuid::v4();
        Database::run($pdo, 'INSERT INTO `user` (id, email, password_hash) VALUES (?, ?, ?)', [$this->userId, 'me@example.org', 'unused']);
        $this->token = (new Sessions(self::$db))->createDeviceWithSession($this->userId, 'Test', 'desktop');
        $this->tag = bin2hex(random_bytes(4));

        $t = $this->tag;
        // [account, path, subject, day, stored locally]
        $this->seed(0, [
            ['INBOX', "Angebot {$t} A1", '2026-01-10', true],
            ['INBOX', "Angebot {$t} A2", '2026-03-10', true],
            ['Archiv', "Angebot {$t} A3", '2026-02-10', true],
        ]);
        $this->seed(1, [
            ['INBOX', "Angebot {$t} B1", '2026-01-20', true],
            ['INBOX', "Angebot {$t} B2", '2026-03-20', false],
        ]);
        $this->seed(2, [
            ['INBOX', "Angebot {$t} C1", '2026-02-25', true],
            ['INBOX', "Etwas anderes {$t}", '2026-02-26', true],
        ]);
    }

    /** @param list<array{string, string, string, bool}> $mails */
    private function seed(int $n, array $mails): void
    {
        $pdo = self::$db->pdo();
        $imapUser = "global-{$this->tag}-{$n}@example.org";
        $accountId = Uuid::v4();
        $dek = Envelope::generateDataKey();
        Database::run(
            $pdo,
            'INSERT INTO mail_account (id, user_id, sort_order, display_name, email_address, imap_host, imap_port, smtp_host, smtp_port, wrapped_dek, key_id, credential_enc)
             VALUES (?, ?, ?, ?, ?, ?, 3143, ?, 3025, ?, ?, ?)',
            [$accountId, $this->userId, $n, "K{$n}", $imapUser, $this->greenmail, $this->greenmail,
                Envelope::wrapDataKey(Envelope::loadMasterKey($this->masterKey), $dek, 'v1'), 'v1',
                Envelope::encryptField($dek, json_encode(['imapUser' => $imapUser, 'imapPassword' => 'pw'], JSON_THROW_ON_ERROR), Envelope::credentialAad($accountId))],
        );
        $this->accounts[] = $accountId;
        $this->deks[$accountId] = $dek;

        $imap = ImapClient::connect(new TransportPolicy(true, true), new HostConfig($this->greenmail, 3143, false, $imapUser, 'pw'));
        try {
            foreach ($mails as [$path, $subject, $day, $stored]) {
                if (!isset($this->folders["{$accountId}/{$path}"])) {
                    if ($path !== 'INBOX') {
                        $imap->command('CREATE ' . ImapClient::quote($path));
                    }
                    $this->folders["{$accountId}/{$path}"] = $this->folder($accountId, $path);
                }
                $date = new \DateTimeImmutable("{$day} 10:00:00", new \DateTimeZone('UTC'));
                $raw = "From: Absender <absender@example.org>\r\nTo: {$imapUser}\r\nSubject: {$subject}\r\nDate: " . $date->format(\DATE_RFC2822)
                    . "\r\nMessage-ID: <" . bin2hex(random_bytes(8)) . "@example.org>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nText.\r\n";
                $result = $imap->execute(['APPEND ' . ImapClient::quote($path) . ' () "' . $date->format('d-M-Y H:i:s O') . '" ', $raw]);
                if (preg_match('/\[APPENDUID (\d+) (\d+)\]/', $result['tagged'], $m) !== 1) {
                    self::fail('no APPENDUID');
                }
                if ($stored) {
                    $this->message($accountId, $this->folders["{$accountId}/{$path}"], (int) $m[1], (int) $m[2], $subject, "{$day} 10:00:00");
                }
            }
        } finally {
            $imap->logout();
        }
    }

    private function folder(string $accountId, string $path): string
    {
        $id = Uuid::v4();
        Database::run(self::$db->pdo(), 'INSERT INTO folder (id, account_id, path, delimiter) VALUES (?, ?, ?, ?)', [$id, $accountId, $path, '/']);

        return $id;
    }

    private function message(string $accountId, string $folderId, int $uidvalidity, int $uid, string $subject, string $sentAt): void
    {
        $id = Uuid::v4();
        $pdo = self::$db->pdo();
        Database::run(
            $pdo,
            'INSERT INTO message (id, account_id, message_id_header, subject_enc, from_enc, recipients_enc, snippet_enc, sent_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [$id, $accountId, "<{$id}@example.org>", $this->enc($accountId, $id, 'subject', $subject), $this->enc($accountId, $id, 'from', '[{"name":"Absender","address":"absender@example.org"}]'),
                $this->enc($accountId, $id, 'recipients', '{"to":[]}'), $this->enc($accountId, $id, 'snippet', 'Text.'), $sentAt],
        );
        Database::run(
            $pdo,
            'INSERT INTO message_location (id, message_id, folder_id, uidvalidity, uid, sort_at)
             SELECT ?, id, ?, ?, ?, ' . MessageRoutes::SORT_AT . ' FROM message m WHERE m.id = ?',
            [Uuid::v4(), $folderId, $uidvalidity, $uid, $id],
        );
    }

    /** @param 'subject'|'from'|'recipients'|'snippet' $field */
    private function enc(string $accountId, string $messageId, string $field, string $value): string
    {
        return Envelope::encryptField($this->deks[$accountId], $value, Envelope::messageFieldAad($field, $messageId));
    }

    /** @param array<string, string> $query */
    private function search(array $query): ResponseInterface
    {
        $request = Http::request('GET', '/api/search?' . http_build_query($query), ['Sec-Fetch-Site' => 'same-origin'])
            ->withCookieParams(['fma_session' => $this->token])
            ->withQueryParams($query);

        return $this->app->handle($request);
    }

    /**
     * @param array<string, string> $query
     *
     * @return array{messages: list<array<string, mixed>>, accounts: list<array<string, mixed>>, total: int, nextCursor: ?string}
     */
    private function body(array $query): array
    {
        $response = $this->search($query);
        self::assertSame(200, $response->getStatusCode(), (string) $response->getBody());

        /** @var array{messages: list<array<string, mixed>>, accounts: list<array<string, mixed>>, total: int, nextCursor: ?string} */
        return Http::json($response);
    }

    private function rateLimitHits(): int
    {
        return (int) Database::run(self::$db->pdo(), "SELECT COALESCE(SUM(hits), 0) FROM rate_limit WHERE bucket = 'search'")->fetchColumn();
    }

    public function testMergesAccountsByDateWithAccountAndFolder(): void
    {
        $body = $this->body(['subject' => "Angebot {$this->tag}"]);
        $t = $this->tag;
        self::assertSame(
            ["Angebot {$t} B2", "Angebot {$t} A2", "Angebot {$t} C1", "Angebot {$t} A3", "Angebot {$t} B1", "Angebot {$t} A1"],
            array_column($body['messages'], 'subject'),
        );
        self::assertSame(6, $body['total']);
        self::assertNull($body['nextCursor']);
        [$a, $b, $c] = $this->accounts;
        self::assertSame([$b, $a, $c, $a, $b, $a], array_column($body['messages'], 'accountId'));
        self::assertSame($this->folders["{$a}/Archiv"], $body['messages'][3]['folderId']);
        self::assertSame(
            [[$a, 'ok', 3], [$b, 'ok', 2], [$c, 'ok', 1]],
            array_map(static fn(array $e): array => [$e['accountId'], $e['status'], $e['matches']], $body['accounts']),
        );

        // Local hit: list item from the database; not synced: headers from the provider.
        $local = $body['messages'][1];
        self::assertTrue($local['synced']);
        self::assertTrue(Uuid::isValid((string) $local['id']));
        self::assertSame('Text.', $local['snippet']);
        $remote = $body['messages'][0];
        self::assertFalse($remote['synced']);
        self::assertNull($remote['id']);
        self::assertSame(['name' => 'Absender', 'address' => 'absender@example.org'], $remote['from']);
        self::assertSame('2026-03-20T10:00:00.000Z', $remote['date']);
        self::assertSame(['seen' => false, 'flagged' => false, 'answered' => false], $remote['flags']);
    }

    public function testCursorPagesWithoutNewSearchAndWithoutGapsOrDuplicates(): void
    {
        $query = ['subject' => "Angebot {$this->tag}", 'limit' => '2'];
        $subjects = [];
        $first = $this->body($query);
        self::assertSame(3, $this->rateLimitHits());
        $subjects = array_merge($subjects, array_column($first['messages'], 'subject'));
        $cursor = $first['nextCursor'];
        $pages = 1;
        while ($cursor !== null) {
            $page = $this->body($query + ['cursor' => $cursor]);
            $subjects = array_merge($subjects, array_column($page['messages'], 'subject'));
            $cursor = $page['nextCursor'];
            self::assertLessThan(10, ++$pages);
        }
        self::assertSame(3, $pages);
        // Later pages read the stored UID lists: no further provider search.
        self::assertSame(3, $this->rateLimitHits());
        $t = $this->tag;
        self::assertSame(
            ["Angebot {$t} B2", "Angebot {$t} A2", "Angebot {$t} C1", "Angebot {$t} A3", "Angebot {$t} B1", "Angebot {$t} A1"],
            $subjects,
        );
    }

    public function testExpiredResultSearchesAgainAndContinues(): void
    {
        $query = ['subject' => "Angebot {$this->tag}", 'limit' => '4'];
        $first = $this->body($query);
        self::assertNotNull($first['nextCursor']);
        Database::run(self::$db->pdo(), 'UPDATE search_result SET expires_at = ?', [time() - 1]);
        $second = $this->body($query + ['cursor' => (string) $first['nextCursor']]);
        self::assertSame(6, $this->rateLimitHits());
        self::assertSame(["Angebot {$this->tag} B1", "Angebot {$this->tag} A1"], array_column($second['messages'], 'subject'));
        self::assertNull($second['nextCursor']);
    }

    public function testCursorFitsOnlyItsQueryAndIsSigned(): void
    {
        $query = ['subject' => "Angebot {$this->tag}", 'limit' => '2'];
        $cursor = (string) $this->body($query)['nextCursor'];
        self::assertSame(400, $this->search(['subject' => 'anders', 'limit' => '2', 'cursor' => $cursor])->getStatusCode());
        [$payload, $mac] = explode('.', $cursor);
        $data = json_decode((string) base64_decode(strtr($payload, '-_', '+/'), true), true);
        \assert(\is_array($data));
        $data['p'] = new \stdClass();
        $forged = rtrim(strtr(base64_encode(json_encode($data, JSON_THROW_ON_ERROR)), '+/', '-_'), '=') . '.' . $mac;
        self::assertSame(400, $this->search($query + ['cursor' => $forged])->getStatusCode());
        self::assertSame(400, $this->search($query + ['cursor' => 'x'])->getStatusCode());
    }

    public function testFailingAccountsGetAStatusAndOthersStillDeliver(): void
    {
        [$a, $b, $c] = $this->accounts;
        Database::run(self::$db->pdo(), "UPDATE mail_account SET status = 'auth_error' WHERE id = ?", [$a]);
        Database::run(self::$db->pdo(), 'UPDATE mail_account SET imap_port = 3999 WHERE id = ?', [$b]);
        $body = $this->body(['subject' => "Angebot {$this->tag}"]);
        self::assertSame(["Angebot {$this->tag} C1"], array_column($body['messages'], 'subject'));
        self::assertSame(
            [[$a, 'auth_error', 'AUTH_ERROR'], [$b, 'error', 'UNREACHABLE'], [$c, 'ok', null]],
            array_map(static fn(array $e): array => [$e['accountId'], $e['status'], $e['code'] ?? null], $body['accounts']),
        );
        // Only the contacted accounts count against their rate limit.
        self::assertSame(2, $this->rateLimitHits());

        // Disabled accounts are left out unless asked for.
        Database::run(self::$db->pdo(), "UPDATE mail_account SET status = 'disabled' WHERE id = ?", [$a]);
        self::assertSame([$b, $c], array_column($this->body(['subject' => 'x'])['accounts'], 'accountId'));
    }

    public function testRateLimitedAccountIsSkipped(): void
    {
        [$a] = $this->accounts;
        $window = intdiv(time(), 60) * 60;
        foreach ([$window, $window + 60] as $start) {
            Database::run(self::$db->pdo(), "INSERT INTO rate_limit (bucket, ip, window_start, hits) VALUES ('search', ?, ?, ?)", [$a, $start, SearchRoutes::RATE_LIMIT]);
        }
        $body = $this->body(['subject' => "Angebot {$this->tag}"]);
        self::assertSame('rate_limited', $body['accounts'][0]['status']);
        self::assertCount(3, $body['messages']);
    }

    public function testScopeAccountsAndFolder(): void
    {
        [$a, $b] = $this->accounts;
        $body = $this->body(['subject' => "Angebot {$this->tag}", 'accounts' => "{$b},{$a}"]);
        self::assertSame([$a, $b], array_column($body['accounts'], 'accountId'));
        self::assertCount(5, $body['messages']);

        $folder = $this->folders["{$a}/Archiv"];
        $body = $this->body(['subject' => "Angebot {$this->tag}", 'accounts' => $a, 'folderId' => $folder]);
        self::assertSame(["Angebot {$this->tag} A3"], array_column($body['messages'], 'subject'));

        self::assertSame(400, $this->search(['subject' => 'x', 'folderId' => $folder])->getStatusCode());
        self::assertSame(404, $this->search(['subject' => 'x', 'accounts' => Uuid::v4()])->getStatusCode());
        self::assertSame(400, $this->search(['subject' => 'x', 'accounts' => 'nope'])->getStatusCode());
        self::assertSame(400, $this->search(['subject' => 'x', 'limit' => '0'])->getStatusCode());
        self::assertSame(400, $this->search(['subject' => 'x', 'limit' => '101'])->getStatusCode());
        self::assertSame(400, $this->search([])->getStatusCode());
    }

    public function testOperatorsMapToImapCriteria(): void
    {
        $body = $this->body(['to' => "global-{$this->tag}-2@example.org", 'subject' => $this->tag]);
        self::assertSame(["Etwas anderes {$this->tag}", "Angebot {$this->tag} C1"], array_column($body['messages'], 'subject'));
        self::assertCount(7, $this->body(['subject' => $this->tag, 'unread' => '1'])['messages']);
        self::assertSame([], $this->body(['subject' => $this->tag, 'attachment' => '1'])['messages']);
        self::assertSame(
            ['parts' => ['TO "x" UNSEEN HEADER Content-Type "multipart/mixed"'], 'utf8' => false],
            ImapActions::searchCriteria(['to' => 'x', 'unread' => true, 'attachment' => true]),
        );
        self::assertSame('Ungültiger Filter.', SearchRoutes::parseQuery(['unread' => 'ja']));
        self::assertSame(['attachment' => true], SearchRoutes::parseQuery(['attachment' => '1', 'unread' => '0']));
    }

    public function testNeverStoresOrLogsTheTerms(): void
    {
        $term = "Geheimnis{$this->tag}";
        Database::run(self::$db->pdo(), 'UPDATE mail_account SET imap_port = 3999 WHERE id = ?', [$this->accounts[1]]);
        $body = $this->body(['q' => $term, 'limit' => '1']);
        self::assertSame([], $body['messages']);
        $this->body(['subject' => "Angebot {$this->tag}", 'limit' => '1']);
        $stored = implode("\n", Database::run(self::$db->pdo(), 'SELECT streams FROM search_result')->fetchAll(\PDO::FETCH_COLUMN));
        self::assertNotSame('', $stored);
        self::assertStringNotContainsString($term, $stored);
        self::assertStringNotContainsString('Angebot', $stored);
        $log = Http::contents($this->logStream);
        self::assertStringNotContainsString($term, $log);
        self::assertStringNotContainsString('Angebot', $log);
        self::assertStringContainsString('search failed', $log);
    }
}
