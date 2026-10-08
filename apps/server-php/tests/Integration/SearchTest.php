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
use Fma\Routes\SearchRoutes;
use Fma\Security\RateLimiter;
use Fma\Tests\Support\FakeConnectionTester;
use Fma\Tests\Support\Http;
use Psr\Http\Message\ResponseInterface;

/**
 * GET /api/accounts/{id}/search against GreenMail (GREENMAIL_HOST, IMAP
 * 3143).
 */
final class SearchTest extends DatabaseTestCase
{
    /** @var \Slim\App<\Psr\Container\ContainerInterface|null> */
    private \Slim\App $app;
    private string $greenmail = '';
    private string $masterKey;
    private string $token;
    private string $accountId;
    private string $dek;
    private string $imapUser;
    private string $tag;
    /** @var resource */
    private $logStream;
    /** @var array<string, string> folder path => id */
    private array $folders = [];
    /** @var array<string, string> subject => local message id */
    private array $local = [];

    protected function setUp(): void
    {
        $host = getenv('GREENMAIL_HOST');
        if (!\is_string($host) || $host === '') {
            self::markTestSkipped('GREENMAIL_HOST not set');
        }
        $this->greenmail = $host;
        $pdo = self::$db->pdo();
        foreach (['job', 'rate_limit', 'mail_account', '`user`'] as $table) {
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
        $userId = Uuid::v4();
        Database::run($pdo, 'INSERT INTO `user` (id, email, password_hash) VALUES (?, ?, ?)', [$userId, 'me@example.org', 'unused']);
        $this->token = (new Sessions(self::$db))->createDeviceWithSession($userId, 'Test', 'desktop');

        $this->tag = bin2hex(random_bytes(4));
        $this->imapUser = "search-{$this->tag}@example.org";
        $this->accountId = Uuid::v4();
        $this->dek = Envelope::generateDataKey();
        Database::run(
            $pdo,
            'INSERT INTO mail_account (id, user_id, display_name, email_address, imap_host, imap_port, smtp_host, smtp_port, wrapped_dek, key_id, credential_enc)
             VALUES (?, ?, ?, ?, ?, 3143, ?, 3025, ?, ?, ?)',
            [$this->accountId, $userId, 'K', $this->imapUser, $this->greenmail, $this->greenmail,
                Envelope::wrapDataKey(Envelope::loadMasterKey($this->masterKey), $this->dek, 'v1'), 'v1',
                Envelope::encryptField($this->dek, json_encode(['imapUser' => $this->imapUser, 'imapPassword' => 'pw'], JSON_THROW_ON_ERROR), Envelope::credentialAad($this->accountId))],
        );
        $this->seed();
    }

    /** Mails at the provider; all but "Urlaub alt" also stored locally. */
    private function seed(): void
    {
        $t = $this->tag;
        $imap = ImapClient::connect(new TransportPolicy(true, true), new HostConfig($this->greenmail, 3143, false, $this->imapUser, 'pw'));
        try {
            foreach (['Ordner A', 'Ordner B', 'Trash'] as $path) {
                $imap->command('CREATE ' . ImapClient::quote($path));
            }
            $this->folders['INBOX'] = $this->folder('INBOX', 'inbox');
            $this->folders['Ordner A'] = $this->folder('Ordner A', null);
            $this->folders['Ordner B'] = $this->folder('Ordner B', null);
            $this->folders['Trash'] = $this->folder('Trash', 'trash');
            $mails = [
                ['Ordner A', "Rechnung {$t} Januar", 'buchhaltung@example.org', '2026-01-15', 'Anbei die Rechnung.', true],
                ['Ordner B', "Rechnung {$t} Februar", 'buchhaltung@example.org', '2026-02-10', 'Anbei die Rechnung.', true],
                ['INBOX', 'Projekttreffen', "anna.{$t}@example.org", '2026-02-05', "Treffen {$t} am Montag.", true],
                ['INBOX', 'Urlaub', 'bob@example.org', '2026-03-01', "Bin weg {$t}body.", true],
                ['INBOX', 'Urlaub alt', 'bob@example.org', '2026-03-02', "Auch weg {$t}body.", false],
                ['INBOX', "Prüfung {$t}", 'bob@example.org', '2026-03-03', 'Grüße aus Köln', true],
                ['Trash', "Rechnung {$t} Papierkorb", 'buchhaltung@example.org', '2026-02-11', 'Alt.', true],
            ];
            foreach ($mails as [$path, $subject, $from, $day, $body, $stored]) {
                $raw = "From: {$from}\r\nTo: {$this->imapUser}\r\nSubject: =?UTF-8?B?" . base64_encode($subject) . "?=\r\n"
                    . 'Date: ' . (new \DateTimeImmutable("{$day} 10:00:00", new \DateTimeZone('UTC')))->format(\DATE_RFC2822) . "\r\n"
                    . 'Message-ID: <' . bin2hex(random_bytes(8)) . "@example.org>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n{$body}\r\n";
                $date = (new \DateTimeImmutable("{$day} 10:00:00", new \DateTimeZone('UTC')))->format('d-M-Y H:i:s O');
                $result = $imap->execute(['APPEND ' . ImapClient::quote($path) . " () \"{$date}\" ", $raw]);
                if (preg_match('/\[APPENDUID (\d+) (\d+)\]/', $result['tagged'], $m) !== 1) {
                    self::fail('no APPENDUID');
                }
                if ($stored) {
                    $this->local[$subject] = $this->message($this->folders[$path], (int) $m[1], (int) $m[2], $subject, "{$day} 10:00:00");
                }
            }
        } finally {
            $imap->logout();
        }
    }

    private function folder(string $path, ?string $specialUse): string
    {
        $id = Uuid::v4();
        Database::run(
            self::$db->pdo(),
            'INSERT INTO folder (id, account_id, path, delimiter, special_use, special_use_detected) VALUES (?, ?, ?, ?, ?, ?)',
            [$id, $this->accountId, $path, '/', $specialUse, $specialUse],
        );

        return $id;
    }

    private function message(string $folderId, int $uidvalidity, int $uid, string $subject, string $sentAt): string
    {
        $id = Uuid::v4();
        $pdo = self::$db->pdo();
        Database::run(
            $pdo,
            'INSERT INTO message (id, account_id, message_id_header, subject_enc, from_enc, recipients_enc, snippet_enc, sent_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [$id, $this->accountId, "<{$id}@example.org>", $this->enc($id, 'subject', $subject), $this->enc($id, 'from', '[{"name":"","address":"x@example.org"}]'),
                $this->enc($id, 'recipients', '{"to":[]}'), $this->enc($id, 'snippet', ''), $sentAt],
        );
        Database::run($pdo, 'INSERT INTO message_location (id, message_id, folder_id, uidvalidity, uid) VALUES (?, ?, ?, ?, ?)', [Uuid::v4(), $id, $folderId, $uidvalidity, $uid]);

        return $id;
    }

    /** @param array<string, string> $query */
    private function search(array $query, ?string $accountId = null): ResponseInterface
    {
        $path = '/api/accounts/' . ($accountId ?? $this->accountId) . '/search?' . http_build_query($query);
        $request = Http::request('GET', $path, ['Sec-Fetch-Site' => 'same-origin'])
            ->withCookieParams(['fma_session' => $this->token])
            ->withQueryParams($query);

        return $this->app->handle($request);
    }

    /**
     * @param array<string, string> $query
     *
     * @return array<string, mixed>
     */
    private function body(array $query): array
    {
        $response = $this->search($query);
        self::assertSame(200, $response->getStatusCode(), (string) $response->getBody());

        /** @var array<string, mixed> */
        return Http::json($response);
    }

    /**
     * @param array<string, mixed> $body
     *
     * @return list<mixed>
     */
    private static function column(array $body, string $key): array
    {
        $messages = $body['messages'];
        \assert(\is_array($messages));

        return array_column($messages, $key);
    }

    public function testFindsBySubjectAcrossFoldersAndMapsHits(): void
    {
        $response = $this->search(['subject' => "Rechnung {$this->tag}"]);
        self::assertSame(200, $response->getStatusCode());
        self::assertSame('no-store', $response->getHeaderLine('Cache-Control'));
        $body = Http::json($response);
        $messages = $body['messages'];
        \assert(\is_array($messages));
        self::assertSame(
            [
                [$this->local["Rechnung {$this->tag} Februar"], $this->folders['Ordner B'], "Rechnung {$this->tag} Februar"],
                [$this->local["Rechnung {$this->tag} Januar"], $this->folders['Ordner A'], "Rechnung {$this->tag} Januar"],
            ],
            array_map(static fn(array $m): array => [$m['id'], $m['folderId'], $m['subject']], $messages),
        );
        // Trash and Junk are not searched by default; INBOX and two folders are.
        self::assertSame(2, $body['providerMatches']);
        self::assertSame(0, $body['notSynced']);
        self::assertFalse($body['truncated']);
        self::assertSame(3, $body['foldersSearched']);
        self::assertSame(0, $body['foldersFailed']);
        self::assertSame(['seen' => false, 'flagged' => false, 'answered' => false], $messages[0]['flags']);
    }

    public function testFindsBySenderAndBodyTextAndCountsUnsynced(): void
    {
        self::assertSame(['Projekttreffen'], self::column($this->body(['from' => "anna.{$this->tag}@example.org"]), 'subject'));

        $body = $this->body(['q' => "{$this->tag}body"]);
        self::assertSame(['Urlaub'], self::column($body, 'subject'));
        self::assertSame(2, $body['providerMatches']);
        self::assertSame(1, $body['notSynced']);
    }

    public function testFiltersByDateRange(): void
    {
        $subjects = self::column($this->body(['q' => $this->tag, 'since' => '2026-02-01', 'before' => '2026-03-01']), 'subject');
        sort($subjects);
        self::assertSame(['Projekttreffen', "Rechnung {$this->tag} Februar"], $subjects);
    }

    public function testSearchesOnlyTheGivenFolderAndNonAsciiTerms(): void
    {
        $body = $this->body(['subject' => "Rechnung {$this->tag}", 'folderId' => $this->folders['Ordner A']]);
        self::assertSame([$this->folders['Ordner A']], self::column($body, 'folderId'));
        self::assertSame(1, $body['foldersSearched']);

        // Explicit Trash folder is searchable.
        $body = $this->body(['subject' => 'Papierkorb', 'folderId' => $this->folders['Trash']]);
        self::assertSame(["Rechnung {$this->tag} Papierkorb"], self::column($body, 'subject'));

        // 8-bit terms go as literal with CHARSET UTF-8.
        self::assertSame(["Prüfung {$this->tag}"], self::column($this->body(['subject' => 'Prüfung']), 'subject'));
    }

    public function testNeverLogsTheQuery(): void
    {
        $secret = 'geheim' . bin2hex(random_bytes(4));
        $this->body(['q' => $secret, 'from' => $secret, 'subject' => $secret]);
        // A failing search logs too: only the code.
        Database::run(self::$db->pdo(), 'UPDATE mail_account SET imap_port = 3999 WHERE id = ?', [$this->accountId]);
        self::assertSame(502, $this->search(['q' => $secret])->getStatusCode());
        $log = Http::contents($this->logStream);
        self::assertStringContainsString('/search', $log);
        self::assertStringContainsString('search failed', $log);
        self::assertStringNotContainsString($secret, $log);
        self::assertStringNotContainsString('q=', $log);
    }

    public function testValidatesInputAndChecksOwnership(): void
    {
        self::assertSame(400, $this->search([])->getStatusCode());
        self::assertSame(400, $this->search(['since' => 'gestern'])->getStatusCode());
        self::assertSame(400, $this->search(['since' => '2026-02-30'])->getStatusCode());
        self::assertSame(400, $this->search(['since' => '2026-03-01', 'before' => '2026-03-01'])->getStatusCode());
        self::assertSame(400, $this->search(['q' => str_repeat('x', SearchRoutes::MAX_TERM_LENGTH + 1)])->getStatusCode());
        self::assertSame(400, $this->search(['q' => 'x', 'folderId' => 'nope'])->getStatusCode());
        self::assertSame(400, $this->search(['q' => "  \t "])->getStatusCode());
        self::assertSame(404, $this->search(['q' => 'x', 'folderId' => Uuid::v4()])->getStatusCode());
        self::assertSame(404, $this->search(['q' => 'x'], Uuid::v4())->getStatusCode());
        self::assertSame(404, $this->search(['q' => 'x'], 'not-a-uuid')->getStatusCode());
        $response = $this->search(['q' => 'x']);
        self::assertSame(200, $response->getStatusCode());
    }

    public function testParsesQueryLikeNode(): void
    {
        self::assertSame(['q' => 'a b', 'folderId' => 'abcdef01-2345-4789-8abc-def012345678'], SearchRoutes::parseQuery(['q' => " a\x01b ", 'folderId' => 'ABCDEF01-2345-4789-8ABC-DEF012345678', 'since' => '']));
        self::assertSame('Ungültiger Suchbegriff.', SearchRoutes::parseQuery(['q' => ['x']]));
        self::assertSame('Bitte einen Suchbegriff oder Zeitraum angeben.', SearchRoutes::parseQuery(['subject' => '']));
        self::assertSame(['parts' => ['TEXT "a\"b" SINCE 1-Feb-2026'], 'utf8' => false], ImapActions::searchCriteria(['q' => 'a"b', 'since' => '2026-02-01']));
        self::assertSame(['parts' => ['TEXT ', 'ä', ' FROM ', 'x', ' BEFORE 3-Mar-2026'], 'utf8' => true], ImapActions::searchCriteria(['q' => 'ä', 'from' => 'x', 'before' => '2026-03-03']));
        self::assertSame('1:3,7,9:10', ImapActions::uidSet([9, 1, 2, 3, 7, 10, 2]));
        self::assertSame(['uidValidity' => '5', 'map' => [1 => 11, 2 => 12, 3 => 13]], ImapActions::copyUid(['* OK [COPYUID 5 1:2,3 11:13] Moved']));
    }

    public function testRateLimitAndAccountErrors(): void
    {
        // Saturate the account's bucket for this and the next window (no minute-boundary flake).
        $window = intdiv(time(), RateLimiter::WINDOW_SECONDS) * RateLimiter::WINDOW_SECONDS;
        foreach ([$window, $window + RateLimiter::WINDOW_SECONDS] as $start) {
            Database::run(self::$db->pdo(), "INSERT INTO rate_limit (bucket, ip, window_start, hits) VALUES ('search', ?, ?, ?)", [$this->accountId, $start, SearchRoutes::RATE_LIMIT]);
        }
        $limited = $this->search(['q' => 'x']);
        self::assertSame(429, $limited->getStatusCode());
        self::assertSame('', $limited->getHeaderLine('Retry-After'));
        // Validation still answers first.
        self::assertSame(400, $this->search([])->getStatusCode());

        Database::run(self::$db->pdo(), 'DELETE FROM rate_limit');
        Database::run(self::$db->pdo(), "UPDATE mail_account SET status = 'auth_error' WHERE id = ?", [$this->accountId]);
        self::assertSame(409, $this->search(['q' => 'x'])->getStatusCode());
        // The provider was not contacted, so nothing was counted.
        self::assertFalse(Database::run(self::$db->pdo(), 'SELECT hits FROM rate_limit')->fetchColumn());

        Database::run(self::$db->pdo(), "UPDATE mail_account SET status = 'ok', imap_port = 3999 WHERE id = ?", [$this->accountId]);
        $response = $this->search(['q' => 'x']);
        self::assertSame(502, $response->getStatusCode());
        self::assertSame(['message' => 'Der Mailanbieter ist nicht erreichbar.', 'code' => 'UNREACHABLE'], Http::json($response));
    }

    /** @param 'subject'|'from'|'recipients'|'snippet' $field */
    private function enc(string $messageId, string $field, string $value): string
    {
        return Envelope::encryptField($this->dek, $value, Envelope::messageFieldAad($field, $messageId));
    }
}
