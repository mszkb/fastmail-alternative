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

/** Config export/import plus /api/settings, /api/storage and the sync routes. */
final class ConfigTransferTest extends DatabaseTestCase
{
    /** @var \Slim\App<\Psr\Container\ContainerInterface|null> */
    private \Slim\App $app;
    private string $masterKey;
    private string $userId;
    private string $token;

    protected function setUp(): void
    {
        $pdo = self::$db->pdo();
        foreach (['job', 'mail_account', '`user`'] as $table) {
            $pdo->exec("DELETE FROM {$table}");
        }
        $this->masterKey = base64_encode(random_bytes(32));
        $config = Config::fromArray(['DATABASE_URL' => self::$config->get('DATABASE_URL'), 'DOMAIN' => 'mail.example.org', 'MASTER_KEY' => $this->masterKey]);
        $this->app = App::create($config, self::$db, new Logger('api', 'info', Http::memoryStream()), [], new FakeConnectionTester());
        $this->userId = Uuid::v4();
        Database::run($pdo, 'INSERT INTO `user` (id, email, password_hash) VALUES (?, ?, ?)', [$this->userId, 'me@example.org', 'unused']);
        $this->token = (new Sessions(self::$db))->createDeviceWithSession($this->userId, 'Test', 'desktop');
    }

    /** @param array<mixed>|null $body */
    private function call(string $method, string $path, ?array $body = null, ?string $raw = null, bool $auth = true): ResponseInterface
    {
        $request = Http::request($method, $path, ['Sec-Fetch-Site' => 'same-origin']);
        if ($body !== null || $raw !== null) {
            $request->getBody()->write($raw ?? json_encode($body, JSON_THROW_ON_ERROR));
            $request = $request->withHeader('Content-Type', 'application/json');
        }
        if ($auth) {
            $request = $request->withCookieParams(['fma_session' => $this->token]);
        }

        return $this->app->handle($request);
    }

    /**
     * @param array<string, mixed> $overrides
     *
     * @return array<string, mixed>
     */
    private static function account(string $email, array $overrides = []): array
    {
        return $overrides + [
            'displayName' => 'Work',
            'emailAddress' => $email,
            'sortOrder' => 3,
            'credentialKind' => 'password',
            'syncSince' => '2026-01-15T00:00:00.000Z',
            'imap' => ['host' => 'IMAP.example.org', 'port' => 993, 'user' => 'imap-user'],
            'smtp' => ['host' => 'smtp.example.org', 'port' => 587, 'user' => ''],
            'identities' => [
                ['name' => "Alias\nName", 'emailAddress' => 'Alias@Example.org', 'signature' => "-- \r\nBye  ", 'isDefault' => true],
            ],
            'folderRoles' => ['sent' => ['path' => 'Gesendet', 'delimiter' => '/']],
        ];
    }

    /**
     * @param list<array<string, mixed>> $accounts
     *
     * @return array<string, mixed>
     */
    private static function file(array $accounts, int $version = 1): array
    {
        return ['format' => 'fma-config', 'version' => $version, 'exportedAt' => '2026-10-01T00:00:00.000Z', 'accounts' => $accounts, 'settings' => []];
    }

    public function testImportCreatesAccountsWithoutCredentialsAndExportRoundTrips(): void
    {
        self::assertSame(401, $this->call('POST', '/api/import/config', self::file([]), auth: false)->getStatusCode());
        $response = $this->call('POST', '/api/import/config', self::file([self::account('Work@Example.org'), self::account('work@example.org')]));
        self::assertSame(200, $response->getStatusCode(), (string) $response->getBody());
        self::assertSame(['imported' => ['work@example.org'], 'skipped' => ['work@example.org']], Http::json($response));

        /** @var array<string, mixed> $row */
        $row = Database::run(self::$db->pdo(), 'SELECT * FROM mail_account WHERE user_id = ?', [$this->userId])->fetch();
        self::assertSame('auth_error', $row['status']);
        self::assertSame('CREDENTIALS_REQUIRED', $row['last_error_code']);
        self::assertSame('imap.example.org', $row['imap_host']);
        $dek = Envelope::unwrapAccountKey($this->masterKey, (string) $row['wrapped_dek']);
        $credentials = json_decode(Envelope::decryptField($dek, (string) $row['credential_enc'], Envelope::credentialAad((string) $row['id'])), true);
        self::assertSame(['imapUser' => 'imap-user', 'imapPassword' => '', 'smtpUser' => 'imap-user', 'smtpPassword' => ''], $credentials);
        // No job runs until the password is entered.
        self::assertSame(0, (int) Database::run(self::$db->pdo(), 'SELECT COUNT(*) FROM job')->fetchColumn());

        $export = $this->call('GET', '/api/export/config');
        self::assertSame(200, $export->getStatusCode());
        self::assertSame('no-store', $export->getHeaderLine('Cache-Control'));
        self::assertMatchesRegularExpression('/^attachment; filename="fma-config-\d{4}-\d{2}-\d{2}\.json"$/', $export->getHeaderLine('Content-Disposition'));
        $body = Http::json($export);
        self::assertSame('fma-config', $body['format']);
        self::assertSame(1, $body['version']);
        self::assertSame([], $body['settings']);
        self::assertStringNotContainsString('Password', (string) $export->getBody());
        self::assertSame([[
            'displayName' => 'Work',
            'emailAddress' => 'work@example.org',
            'sortOrder' => 3,
            'credentialKind' => 'password',
            'syncSince' => '2026-01-15T00:00:00.000Z',
            'imap' => ['host' => 'imap.example.org', 'port' => 993, 'user' => 'imap-user'],
            'smtp' => ['host' => 'smtp.example.org', 'port' => 587, 'user' => 'imap-user'],
            'identities' => [
                ['name' => 'Alias Name', 'emailAddress' => 'alias@example.org', 'signature' => "-- \nBye", 'isDefault' => true],
                ['name' => 'Work', 'emailAddress' => 'work@example.org', 'signature' => null, 'isDefault' => false],
            ],
            'folderRoles' => ['sent' => ['path' => 'Gesendet', 'delimiter' => '/']],
        ]], $body['accounts']);
    }

    public function testImportValidation(): void
    {
        $cases = [
            [['format' => 'other'], 'Keine Konfigurationsdatei dieser App.'],
            [self::file([], 2), 'Die Datei stammt aus einer neueren Version und kann nicht importiert werden.'],
            [['format' => 'fma-config', 'version' => 1, 'accounts' => 'x'], 'Ungültige Kontenliste.'],
            [self::file([self::account('nope')]), 'Konto 1: ungültige E-Mail-Adresse.'],
            [self::file([self::account('a@example.org', ['imap' => ['host' => 'a b', 'port' => 993, 'user' => 'u']])]), 'Konto 1 (IMAP): Host, Port oder Benutzer ungültig.'],
            [self::file([self::account('a@example.org', ['imap' => ['host' => 'imap.example.org', 'port' => 993, 'user' => '']])]), 'Konto 1 (IMAP): Benutzername fehlt.'],
            [self::file([self::account('a@example.org', ['smtp' => ['host' => 'smtp.example.org', 'port' => 8025]])]), 'Konto 1 (SMTP): Port 8025 ist nicht erlaubt (MAIL_EXTRA_PORTS).'],
            [self::file([self::account('a@example.org', ['identities' => [['emailAddress' => 'x']]])]), 'Konto 1: ungültige Identität.'],
            [self::file([self::account('a@example.org', ['folderRoles' => ['inbox' => ['path' => 'X']]])]), 'Konto 1: ungültige Ordnerzuordnung.'],
            [self::file([self::account('a@example.org', ['folderRoles' => ['sent' => ['path' => 'inbox']]])]), 'Konto 1: ungültige Ordnerzuordnung.'],
        ];
        foreach ($cases as [$body, $message]) {
            $response = $this->call('POST', '/api/import/config', $body);
            self::assertSame(400, $response->getStatusCode(), $message);
            self::assertSame(['message' => $message], Http::json($response));
        }
        self::assertSame(413, $this->call('POST', '/api/import/config', raw: str_repeat(' ', 2 * 1024 * 1024 + 1))->getStatusCode());
        self::assertSame(0, (int) Database::run(self::$db->pdo(), 'SELECT COUNT(*) FROM mail_account')->fetchColumn());
    }

    public function testImportRespectsTheAccountLimitAtomically(): void
    {
        $accounts = [];
        for ($i = 0; $i < 21; ++$i) {
            $accounts[] = self::account("a{$i}@example.org");
        }
        self::assertSame(400, $this->call('POST', '/api/import/config', self::file($accounts))->getStatusCode());
        // 20 accounts per file pass validation; with one existing account the 20th exceeds the limit.
        self::assertSame(200, $this->call('POST', '/api/import/config', self::file([self::account('first@example.org')]))->getStatusCode());
        $response = $this->call('POST', '/api/import/config', self::file(\array_slice($accounts, 0, 20)));
        self::assertSame(409, $response->getStatusCode());
        self::assertSame(['message' => 'Maximale Anzahl an Konten erreicht.'], Http::json($response));
        self::assertSame(1, (int) Database::run(self::$db->pdo(), 'SELECT COUNT(*) FROM mail_account')->fetchColumn());
    }

    public function testSettings(): void
    {
        self::assertSame(401, $this->call('GET', '/api/settings', auth: false)->getStatusCode());
        self::assertSame(['unifiedInbox' => false], Http::json($this->call('GET', '/api/settings')));
        self::assertSame(400, $this->call('PUT', '/api/settings', ['unifiedInbox' => 'yes'])->getStatusCode());
        self::assertSame(['message' => 'Ungültige Einstellungen.'], Http::json($this->call('PUT', '/api/settings', [])));
        self::assertSame(['unifiedInbox' => true], Http::json($this->call('PUT', '/api/settings', ['unifiedInbox' => true])));
        self::assertSame(['unifiedInbox' => true], Http::json($this->call('GET', '/api/settings')));
    }

    private function insertAccount(string $status = 'ok', int $sortOrder = 0, ?string $userId = null): string
    {
        $id = Uuid::v4();
        Database::run(
            self::$db->pdo(),
            "INSERT INTO mail_account (id, user_id, display_name, email_address, imap_host, imap_port,
               smtp_host, smtp_port, wrapped_dek, key_id, credential_enc, status, sort_order)
             VALUES (?, ?, 'A', ?, 'imap.test', 993, 'smtp.test', 465, 'x', 'v1', 'x', ?, ?)",
            [$id, $userId ?? $this->userId, "{$id}@example.org", $status, $sortOrder],
        );

        return $id;
    }

    public function testStorage(): void
    {
        $a = $this->insertAccount(sortOrder: 1);
        $b = $this->insertAccount(sortOrder: 2);
        $foreign = Uuid::v4();
        Database::run(self::$db->pdo(), 'INSERT INTO `user` (id, email, password_hash) VALUES (?, ?, ?)', [$foreign, 'other@example.org', 'x']);
        $other = $this->insertAccount(userId: $foreign);
        foreach ([[$a, 100, true], [$a, 50, false], [$other, 999, true]] as [$account, $size, $stored]) {
            $id = Uuid::v4();
            Database::run(
                self::$db->pdo(),
                "INSERT INTO message (id, account_id, message_id_header, subject_enc, from_enc, recipients_enc, snippet_enc, size_bytes)
                 VALUES (?, ?, ?, 'x', 'x', 'x', 'x', ?)",
                [$id, $account, "<{$id}>", $size],
            );
            if ($stored) {
                Database::run(self::$db->pdo(), 'INSERT INTO message_body (message_id, storage_ref) VALUES (?, ?)', [$id, "{$account}/{$id}/raw.eml.enc"]);
            }
        }
        Database::run(
            self::$db->pdo(),
            "INSERT INTO attachment_upload (id, account_id, filename_enc, content_type, size_bytes, content_enc) VALUES (?, ?, 'x', 'text/plain', 7, 'x')",
            [Uuid::v4(), $b],
        );

        $all = Http::json($this->call('GET', '/api/storage'));
        self::assertSame([
            'accounts' => [
                ['accountId' => $a, 'messageCount' => 2, 'storedMessageCount' => 1, 'messageBytes' => 100, 'uploadCount' => 0, 'uploadBytes' => 0, 'totalBytes' => 100],
                ['accountId' => $b, 'messageCount' => 0, 'storedMessageCount' => 0, 'messageBytes' => 0, 'uploadCount' => 1, 'uploadBytes' => 7, 'totalBytes' => 7],
            ],
            'totalBytes' => 107,
        ], $all);
        self::assertSame(100, Http::json($this->call('GET', "/api/accounts/{$a}/storage"))['totalBytes']);
        self::assertSame(404, $this->call('GET', "/api/accounts/{$other}/storage")->getStatusCode());
        self::assertSame(404, $this->call('GET', '/api/accounts/nope/storage')->getStatusCode());
    }

    public function testSyncRequests(): void
    {
        $ok = $this->insertAccount(sortOrder: 1);
        $authError = $this->insertAccount('auth_error', 2);
        $disabled = $this->insertAccount('disabled', 3);
        $backoff = $this->insertAccount(sortOrder: 4);
        Database::run(self::$db->pdo(), 'UPDATE mail_account SET next_retry_at = UTC_TIMESTAMP(6) + INTERVAL 1 HOUR WHERE id = ?', [$backoff]);

        $response = $this->call('POST', "/api/accounts/{$ok}/sync");
        self::assertSame(202, $response->getStatusCode());
        self::assertSame(['accountId' => $ok, 'queued' => true, 'reason' => null], Http::json($response));
        $response = $this->call('POST', "/api/accounts/{$ok}/sync");
        self::assertSame(200, $response->getStatusCode());
        self::assertSame('pending', Http::json($response)['reason']);

        // Done but recent: rate limited.
        self::$db->pdo()->exec("UPDATE job SET state = 'done'");
        $response = $this->call('POST', "/api/accounts/{$ok}/sync");
        self::assertSame(429, $response->getStatusCode());
        self::assertSame('30', $response->getHeaderLine('Retry-After'));
        self::assertSame('rate_limited', Http::json($response)['reason']);

        self::assertSame(404, $this->call('POST', '/api/accounts/' . Uuid::v4() . '/sync')->getStatusCode());
        self::assertSame(['accounts' => [
            ['accountId' => $ok, 'queued' => false, 'reason' => 'rate_limited'],
            ['accountId' => $authError, 'queued' => false, 'reason' => 'auth_error'],
            ['accountId' => $disabled, 'queued' => false, 'reason' => 'disabled'],
            ['accountId' => $backoff, 'queued' => false, 'reason' => 'backoff'],
        ]], Http::json($this->call('POST', '/api/sync')));
        self::assertSame(1, (int) Database::run(self::$db->pdo(), "SELECT COUNT(*) FROM job WHERE type = 'folder_sync'")->fetchColumn());
    }
}
