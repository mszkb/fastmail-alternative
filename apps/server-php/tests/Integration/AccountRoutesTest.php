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

final class AccountRoutesTest extends DatabaseTestCase
{
    private const AUTH_FAILED = 'Zugangsdaten wurden abgelehnt.';

    /** @var \Slim\App<\Psr\Container\ContainerInterface|null> */
    private \Slim\App $app;
    private string $masterKey;
    private string $userId;
    private string $token;
    private FakeConnectionTester $tester;

    protected function setUp(): void
    {
        $pdo = self::$db->pdo();
        foreach (['job', 'mail_account', '`user`'] as $table) {
            $pdo->exec("DELETE FROM {$table}");
        }
        $this->masterKey = base64_encode(random_bytes(32));
        $config = Config::fromArray(['DATABASE_URL' => self::$config->get('DATABASE_URL'), 'DOMAIN' => 'mail.example.org', 'MASTER_KEY' => $this->masterKey]);
        $this->tester = new FakeConnectionTester();
        $this->app = App::create($config, self::$db, new Logger('api', 'info', Http::memoryStream()), [], $this->tester);
        $this->userId = $this->createUser('me@example.org');
        $this->token = (new Sessions(self::$db))->createDeviceWithSession($this->userId, 'Test', 'desktop');
    }

    private function createUser(string $email): string
    {
        $id = Uuid::v4();
        Database::run(self::$db->pdo(), 'INSERT INTO `user` (id, email, password_hash) VALUES (?, ?, ?)', [$id, $email, 'unused']);

        return $id;
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
    private static function validBody(array $overrides = []): array
    {
        return $overrides + [
            'emailAddress' => ' Me@Example.ORG ',
            'imap' => ['host' => 'IMAP.Example.org', 'port' => 993, 'user' => 'me@example.org', 'password' => 'imap-secret'],
            'smtp' => ['host' => 'smtp.example.org', 'port' => 587],
        ];
    }

    /**
     * @param array<string, mixed> $overrides
     *
     * @return array<string, mixed> the created account
     */
    private function createAccount(array $overrides = []): array
    {
        $response = $this->call('POST', '/api/accounts', self::validBody($overrides));
        self::assertSame(201, $response->getStatusCode(), (string) $response->getBody());
        $account = Http::json($response)['account'];
        \assert(\is_array($account));

        return $account;
    }

    /** @return array<string, mixed> */
    private function storedCredentials(string $accountId): array
    {
        /** @var array{wrapped_dek: string, credential_enc: string} $row */
        $row = Database::run(self::$db->pdo(), 'SELECT wrapped_dek, credential_enc FROM mail_account WHERE id = ?', [$accountId])->fetch();
        $dek = Envelope::unwrapAccountKey($this->masterKey, $row['wrapped_dek']);
        $json = Envelope::decryptField($dek, $row['credential_enc'], Envelope::credentialAad($accountId));
        $data = json_decode($json, true, flags: JSON_THROW_ON_ERROR);
        \assert(\is_array($data));

        return $data;
    }

    /** @return list<array{type: string, account_id: ?string, payload: string}> */
    private static function jobs(): array
    {
        /** @var list<array{type: string, account_id: ?string, payload: string}> */
        return Database::run(self::$db->pdo(), 'SELECT type, account_id, payload FROM job ORDER BY id')->fetchAll();
    }

    public function testListRequiresAuthAndStartsEmpty(): void
    {
        self::assertSame(401, $this->call('GET', '/api/accounts', auth: false)->getStatusCode());
        $response = $this->call('GET', '/api/accounts');
        self::assertSame(200, $response->getStatusCode());
        self::assertSame(['accounts' => []], Http::json($response));
    }

    public function testCreateStoresEncryptedCredentialsAndDefaultIdentity(): void
    {
        $this->tester->capabilities = ['IMAP4rev1', 'IDLE'];
        $response = $this->call('POST', '/api/accounts', self::validBody(['syncSince' => '2026-01-15']));
        self::assertSame(201, $response->getStatusCode(), (string) $response->getBody());
        $body = Http::json($response);
        $account = $body['account'];
        \assert(\is_array($account));
        $id = $account['id'];
        \assert(\is_string($id));
        self::assertTrue(Uuid::isValid($id));
        self::assertSame([
            'id' => $id,
            'displayName' => 'me@example.org',
            'emailAddress' => 'me@example.org',
            'imap' => ['host' => 'imap.example.org', 'port' => 993],
            'smtp' => ['host' => 'smtp.example.org', 'port' => 587],
            'status' => 'ok',
            'lastErrorCode' => null,
            'nextRetryAt' => null,
            'capabilities' => ['IMAP4rev1', 'IDLE'],
            'sortOrder' => 0,
            'lastSyncAt' => null,
            'syncSince' => '2026-01-15',
            'unreadCount' => 0,
            'syncing' => false,
        ], $account);
        self::assertSame(['imap' => ['ok' => true, 'capabilities' => ['IMAP4rev1', 'IDLE']], 'smtp' => ['ok' => true]], $body['test']);

        // The tester got normalized hosts, TLS by port and SMTP credentials falling back to IMAP.
        [$imap, $smtp] = $this->tester->calls;
        self::assertSame(['imap.example.org', 993, true, 'me@example.org', 'imap-secret'], [$imap->host, $imap->port, $imap->secure, $imap->user, $imap->password]);
        self::assertSame(['smtp.example.org', 587, false, 'me@example.org', 'imap-secret'], [$smtp->host, $smtp->port, $smtp->secure, $smtp->user, $smtp->password]);

        /** @var array{wrapped_dek: string, key_id: string, credential_enc: string, sync_since: string, default_identity_id: string} $row */
        $row = Database::run(self::$db->pdo(), 'SELECT wrapped_dek, key_id, credential_enc, sync_since, default_identity_id FROM mail_account WHERE id = ?', [$id])->fetch();
        self::assertStringStartsWith('fma.k1.', $row['wrapped_dek']);
        self::assertSame('v1', $row['key_id']);
        self::assertStringStartsWith('fma.f1.', $row['credential_enc']);
        self::assertStringNotContainsString('imap-secret', $row['credential_enc']);
        self::assertSame('2026-01-15 00:00:00.000000', $row['sync_since']);
        self::assertSame(
            ['imapUser' => 'me@example.org', 'imapPassword' => 'imap-secret', 'smtpUser' => 'me@example.org', 'smtpPassword' => 'imap-secret'],
            $this->storedCredentials($id),
        );

        $identity = Database::run(self::$db->pdo(), 'SELECT id, name, email_address FROM identity WHERE account_id = ?', [$id])->fetchAll();
        self::assertSame([['id' => $row['default_identity_id'], 'name' => 'me@example.org', 'email_address' => 'me@example.org']], $identity);
        self::assertSame([['type' => 'folder_sync', 'account_id' => $id, 'payload' => '{}']], self::jobs());

        // The queued folder_sync shows as syncing in the list.
        $list = Http::json($this->call('GET', '/api/accounts'))['accounts'];
        \assert(\is_array($list) && \is_array($list[0]));
        self::assertCount(1, $list);
        self::assertTrue($list[0]['syncing']);
        self::assertSame(0, $list[0]['unreadCount']);
    }

    public function testCreateWithSeparateSmtpCredentialsAndDisplayName(): void
    {
        $account = $this->createAccount([
            'displayName' => '  Work  ',
            'smtp' => ['host' => '192.0.2.10', 'port' => 465, 'user' => ' smtp-user ', 'password' => 'smtp-secret'],
        ]);
        self::assertSame('Work', $account['displayName']);
        self::assertSame(['host' => '192.0.2.10', 'port' => 465], $account['smtp']);
        \assert(\is_string($account['id']));
        self::assertSame(
            ['imapUser' => 'me@example.org', 'imapPassword' => 'imap-secret', 'smtpUser' => 'smtp-user', 'smtpPassword' => 'smtp-secret'],
            $this->storedCredentials($account['id']),
        );
        self::assertTrue($this->tester->calls[1]->secure);
    }

    public function testFailedConnectionTestIs422AndStoresNothing(): void
    {
        $this->tester->imapCode = 'AUTH_FAILED';
        $response = $this->call('POST', '/api/accounts', self::validBody());
        self::assertSame(422, $response->getStatusCode());
        self::assertSame(['stage' => 'imap', 'test' => ['ok' => false, 'code' => 'AUTH_FAILED', 'message' => self::AUTH_FAILED]], Http::json($response));
        self::assertCount(1, $this->tester->calls, 'SMTP is not tested after an IMAP failure');

        $this->tester->imapCode = null;
        $this->tester->smtpCode = 'AUTH_FAILED';
        $response = $this->call('POST', '/api/accounts', self::validBody());
        self::assertSame(422, $response->getStatusCode());
        self::assertSame(['stage' => 'smtp', 'test' => ['ok' => false, 'code' => 'AUTH_FAILED', 'message' => self::AUTH_FAILED]], Http::json($response));
        self::assertSame(0, (int) Database::run(self::$db->pdo(), 'SELECT COUNT(*) FROM mail_account')->fetchColumn());
        self::assertSame([], self::jobs());
    }

    public function testInvalidCreateBodiesAre400(): void
    {
        $message = ['message' => 'Ungültige Kontodaten (E-Mail, Host, Port, Benutzer, Passwort, Sync-Zeitraum prüfen).'];
        $imap = self::validBody()['imap'];
        \assert(\is_array($imap));
        $invalid = [
            self::validBody(['emailAddress' => 'not-an-email']),
            self::validBody(['emailAddress' => 42]),
            self::validBody(['displayName' => null]),
            self::validBody(['imap' => ['password' => ''] + $imap]),
            self::validBody(['imap' => ['user' => 5] + $imap]),
            self::validBody(['imap' => ['host' => 'https://imap.example.org/'] + $imap]),
            self::validBody(['imap' => ['host' => 'imap.example.org:993'] + $imap]),
            self::validBody(['imap' => ['port' => 0] + $imap]),
            self::validBody(['imap' => ['port' => '993'] + $imap]),
            self::validBody(['imap' => ['port' => 99.5] + $imap]),
            self::validBody(['smtp' => 'smtp.example.org']),
            self::validBody(['smtp' => ['host' => 'smtp.example.org', 'port' => 587, 'user' => null]]),
            self::validBody(['syncSince' => '2026-02-30']),
            self::validBody(['syncSince' => '1969-12-31']),
            self::validBody(['syncSince' => '2999-01-01']),
            self::validBody(['syncSince' => 30]),
            [],
        ];
        foreach ($invalid as $i => $body) {
            $response = $this->call('POST', '/api/accounts', $body);
            self::assertSame(400, $response->getStatusCode(), "case {$i}");
            self::assertSame($message, Http::json($response));
        }
        self::assertSame([], $this->tester->calls);
        // A float port with an integral value counts as an integer (Number.isInteger semantics).
        self::assertSame(201, $this->call('POST', '/api/accounts', raw: str_replace('993', '993.0', json_encode(self::validBody(), JSON_THROW_ON_ERROR)))->getStatusCode());
    }

    public function testAccountLimitIs409(): void
    {
        for ($i = 0; $i < 20; ++$i) {
            $this->createAccount();
        }
        $response = $this->call('POST', '/api/accounts', self::validBody());
        self::assertSame(409, $response->getStatusCode());
        self::assertSame(['message' => 'Maximale Anzahl an Konten erreicht.'], Http::json($response));
    }

    public function testPatchNameOrderAndSyncSince(): void
    {
        $account = $this->createAccount();
        $id = (string) $account['id'];
        Database::run(self::$db->pdo(), 'DELETE FROM job');
        $this->tester->reset();

        $response = $this->call('PATCH', "/api/accounts/{$id}", ['displayName' => ' Private ', 'sortOrder' => 3]);
        self::assertSame(200, $response->getStatusCode());
        $body = Http::json($response);
        self::assertSame(['account'], array_keys($body));
        \assert(\is_array($body['account']));
        self::assertSame(['Private', 3], [$body['account']['displayName'], $body['account']['sortOrder']]);
        self::assertSame([], self::jobs(), 'no re-sync for name/order');
        self::assertSame([], $this->tester->calls);

        $response = $this->call('PATCH', '/api/accounts/' . strtoupper($id), ['syncSince' => '2026-03-01']);
        self::assertSame(200, $response->getStatusCode());
        $patched = Http::json($response)['account'];
        \assert(\is_array($patched));
        self::assertSame('2026-03-01', $patched['syncSince']);
        self::assertSame([['type' => 'folder_sync', 'account_id' => $id, 'payload' => '{}']], self::jobs());

        $response = $this->call('PATCH', "/api/accounts/{$id}", ['syncSince' => null]);
        $patched = Http::json($response)['account'];
        \assert(\is_array($patched));
        self::assertNull($patched['syncSince']);

        self::assertSame(200, $this->call('PATCH', "/api/accounts/{$id}", [])->getStatusCode());
    }

    public function testPatchConnectionRetestsAndClearsTheErrorState(): void
    {
        $account = $this->createAccount();
        $id = (string) $account['id'];
        Database::run(self::$db->pdo(), "UPDATE mail_account SET status = 'auth_error', error_count = 3, last_error_code = 'AUTH_FAILED', next_retry_at = '2030-01-01 00:00:00' WHERE id = ?", [$id]);
        Database::run(self::$db->pdo(), 'DELETE FROM job');
        $this->tester->reset();
        $this->tester->capabilities = ['IMAP4rev1', 'CONDSTORE'];

        // Failing test: nothing is saved.
        $this->tester->imapCode = 'AUTH_FAILED';
        $response = $this->call('PATCH', "/api/accounts/{$id}", ['imap' => ['password' => 'new-secret']]);
        self::assertSame(422, $response->getStatusCode());
        self::assertSame(['stage' => 'imap', 'test' => ['ok' => false, 'code' => 'AUTH_FAILED', 'message' => self::AUTH_FAILED]], Http::json($response));
        self::assertSame('imap-secret', $this->storedCredentials($id)['imapPassword']);

        // SMTP credentials identical to IMAP follow the IMAP change; empty fields mean "unchanged".
        $this->tester->imapCode = null;
        $this->tester->reset();
        $response = $this->call('PATCH', "/api/accounts/{$id}", ['imap' => ['password' => 'new-secret', 'user' => ''], 'smtp' => ['port' => 465, 'password' => null]]);
        self::assertSame(200, $response->getStatusCode(), (string) $response->getBody());
        $body = Http::json($response);
        self::assertSame(['imap' => ['ok' => true, 'capabilities' => ['IMAP4rev1', 'CONDSTORE']], 'smtp' => ['ok' => true]], $body['test']);
        \assert(\is_array($body['account']));
        self::assertSame(['ok', null, null, ['IMAP4rev1', 'CONDSTORE'], ['host' => 'smtp.example.org', 'port' => 465]], [
            $body['account']['status'], $body['account']['lastErrorCode'], $body['account']['nextRetryAt'], $body['account']['capabilities'], $body['account']['smtp'],
        ]);
        [$imap, $smtp] = $this->tester->calls;
        self::assertSame(['me@example.org', 'new-secret'], [$imap->user, $imap->password]);
        self::assertSame(['me@example.org', 'new-secret', true], [$smtp->user, $smtp->password, $smtp->secure]);
        self::assertSame(
            ['imapUser' => 'me@example.org', 'imapPassword' => 'new-secret', 'smtpUser' => 'me@example.org', 'smtpPassword' => 'new-secret'],
            $this->storedCredentials($id),
        );
        self::assertSame(0, (int) Database::run(self::$db->pdo(), 'SELECT error_count FROM mail_account WHERE id = ?', [$id])->fetchColumn());
        self::assertSame([['type' => 'folder_sync', 'account_id' => $id, 'payload' => '{}']], self::jobs());
    }

    public function testPatchValidationAndNotFound(): void
    {
        $id = (string) $this->createAccount()['id'];
        $message = ['message' => 'Ungültige Kontodaten (Name, Host, Port, Benutzer, Passwort, Sync-Zeitraum prüfen).'];
        foreach ([['displayName' => '   '], ['displayName' => 5], ['sortOrder' => 1.5], ['sortOrder' => 1_000_001], ['syncSince' => 'yesterday'], ['imap' => null], ['imap' => ['host' => 'bad host']], ['smtp' => ['port' => 70000]], ['smtp' => ['user' => 5]]] as $i => $body) {
            $response = $this->call('PATCH', "/api/accounts/{$id}", $body);
            self::assertSame(400, $response->getStatusCode(), "case {$i}");
            self::assertSame($message, Http::json($response));
        }
        self::assertSame(400, $this->call('PATCH', "/api/accounts/{$id}")->getStatusCode(), 'missing body');
        self::assertSame(400, $this->call('PATCH', "/api/accounts/{$id}", raw: '"text"')->getStatusCode(), 'non-object body');

        $notFound = ['message' => 'Konto nicht gefunden.'];
        foreach (['not-a-uuid', Uuid::v4(), $this->foreignAccount()] as $other) {
            $response = $this->call('PATCH', "/api/accounts/{$other}", ['displayName' => 'x']);
            self::assertSame(404, $response->getStatusCode());
            self::assertSame($notFound, Http::json($response));
            $response = $this->call('DELETE', "/api/accounts/{$other}");
            self::assertSame(404, $response->getStatusCode());
            self::assertSame($notFound, Http::json($response));
        }
    }

    public function testDeleteCascadesAndEnqueuesTheCleanup(): void
    {
        $id = (string) $this->createAccount()['id'];
        $foreign = $this->foreignAccount();
        $response = $this->call('DELETE', "/api/accounts/{$id}");
        self::assertSame(204, $response->getStatusCode());
        self::assertSame('', (string) $response->getBody());
        self::assertSame(0, (int) Database::run(self::$db->pdo(), 'SELECT COUNT(*) FROM mail_account WHERE id = ?', [$id])->fetchColumn());
        self::assertSame(0, (int) Database::run(self::$db->pdo(), 'SELECT COUNT(*) FROM identity WHERE account_id = ?', [$id])->fetchColumn());
        // The folder_sync job went with the account; the cleanup job carries the id in its payload only.
        $jobs = self::jobs();
        self::assertCount(1, $jobs);
        self::assertSame(['account_cleanup', null], [$jobs[0]['type'], $jobs[0]['account_id']]);
        self::assertSame(['accountId' => $id], json_decode($jobs[0]['payload'], true));
        self::assertSame(1, (int) Database::run(self::$db->pdo(), 'SELECT COUNT(*) FROM mail_account WHERE id = ?', [$foreign])->fetchColumn());
    }

    public function testIdentitiesCrud(): void
    {
        $accountId = (string) $this->createAccount(['displayName' => 'Me'])['id'];
        $base = "/api/accounts/{$accountId}/identities";

        $list = Http::json($this->call('GET', $base))['identities'];
        \assert(\is_array($list) && \is_array($list[0]));
        self::assertCount(1, $list);
        $defaultId = $list[0]['id'];
        self::assertSame(['id' => $defaultId, 'name' => 'Me', 'emailAddress' => 'me@example.org', 'signature' => null, 'isDefault' => true], $list[0]);

        $response = $this->call('POST', $base, ['emailAddress' => ' Alias@Example.org ', 'name' => " Me\r\n(Alias) ", 'signature' => "-- \r\nMe  \r\n\n"]);
        self::assertSame(201, $response->getStatusCode(), (string) $response->getBody());
        $alias = Http::json($response)['identity'];
        \assert(\is_array($alias) && \is_string($alias['id']));
        self::assertSame(['id' => $alias['id'], 'name' => 'Me (Alias)', 'emailAddress' => 'alias@example.org', 'signature' => "-- \nMe", 'isDefault' => false], $alias);

        $duplicate = $this->call('POST', $base, ['emailAddress' => 'ALIAS@example.org']);
        self::assertSame(409, $duplicate->getStatusCode());
        self::assertSame(['message' => 'Diese Adresse ist für das Konto bereits eingetragen.'], Http::json($duplicate));

        foreach ([
            [['emailAddress' => 'a@b'], 'Ungültige E-Mail-Adresse.'],
            [['emailAddress' => 'a<b>@example.org'], 'Ungültige E-Mail-Adresse.'],
            [['emailAddress' => 'x@example.org', 'name' => 5], 'Ungültiger Name.'],
            [['emailAddress' => 'x@example.org', 'name' => str_repeat('ä', 101)], 'Der Name ist zu lang.'],
            [['emailAddress' => 'x@example.org', 'signature' => []], 'Ungültige Signatur.'],
            [['emailAddress' => 'x@example.org', 'signature' => str_repeat('x', 10_001)], 'Die Signatur ist zu lang.'],
        ] as [$body, $message]) {
            $response = $this->call('POST', $base, $body);
            self::assertSame(400, $response->getStatusCode(), $message);
            self::assertSame(['message' => $message], Http::json($response));
        }

        // Update name/signature, then make the alias the default.
        $response = $this->call('PATCH', "/api/identities/{$alias['id']}", ['name' => 'Alias', 'signature' => '   ']);
        self::assertSame(200, $response->getStatusCode());
        self::assertSame(['id' => $alias['id'], 'name' => 'Alias', 'emailAddress' => 'alias@example.org', 'signature' => null, 'isDefault' => false], Http::json($response)['identity']);
        foreach ([
            [[], 'Keine Änderung angegeben.'],
            [['isDefault' => false], 'Eine andere Identität als Standard wählen, um diese abzulösen.'],
            [['name' => null], 'Ungültiger Name.'],
        ] as [$body, $message]) {
            $response = $this->call('PATCH', "/api/identities/{$alias['id']}", $body);
            self::assertSame(400, $response->getStatusCode(), $message);
            self::assertSame(['message' => $message], Http::json($response));
        }
        $response = $this->call('PATCH', "/api/identities/{$alias['id']}", ['isDefault' => true]);
        self::assertSame(200, $response->getStatusCode());
        $updated = Http::json($response)['identity'];
        \assert(\is_array($updated));
        self::assertTrue($updated['isDefault']);
        $list = Http::json($this->call('GET', $base))['identities'];
        \assert(\is_array($list));
        self::assertSame([[$alias['id'], true], [$defaultId, false]], array_map(static fn(array $i): array => [$i['id'], $i['isDefault']], $list));

        // The default identity cannot be removed; the others can.
        $response = $this->call('DELETE', "/api/identities/{$alias['id']}");
        self::assertSame(409, $response->getStatusCode());
        self::assertSame(['message' => 'Die Standard-Identität kann nicht entfernt werden.'], Http::json($response));
        self::assertSame(204, $this->call('DELETE', "/api/identities/{$defaultId}")->getStatusCode());
        self::assertCount(1, (array) Http::json($this->call('GET', $base))['identities']);
    }

    public function testIdentityDefaultFallsBackToTheAccountAddress(): void
    {
        $accountId = (string) $this->createAccount()['id'];
        Database::run(self::$db->pdo(), 'UPDATE mail_account SET default_identity_id = NULL WHERE id = ?', [$accountId]);
        $this->call('POST', "/api/accounts/{$accountId}/identities", ['emailAddress' => 'a-alias@example.org']);
        $list = Http::json($this->call('GET', "/api/accounts/{$accountId}/identities"))['identities'];
        \assert(\is_array($list));
        self::assertSame([['me@example.org', true], ['a-alias@example.org', false]], array_map(static fn(array $i): array => [$i['emailAddress'], $i['isDefault']], $list));
    }

    public function testIdentityLimitAndNotFound(): void
    {
        $accountId = (string) $this->createAccount()['id'];
        for ($i = 1; $i < 20; ++$i) {
            self::assertSame(201, $this->call('POST', "/api/accounts/{$accountId}/identities", ['emailAddress' => "alias{$i}@example.org"])->getStatusCode());
        }
        $response = $this->call('POST', "/api/accounts/{$accountId}/identities", ['emailAddress' => 'one-more@example.org']);
        self::assertSame(409, $response->getStatusCode());
        self::assertSame(['message' => 'Zu viele Identitäten für dieses Konto.'], Http::json($response));

        $foreign = $this->foreignAccount();
        $foreignIdentity = (string) Database::run(self::$db->pdo(), 'SELECT id FROM identity WHERE account_id = ?', [$foreign])->fetchColumn();
        foreach (['not-a-uuid', Uuid::v4(), $foreign] as $other) {
            foreach ([['GET', null], ['POST', ['emailAddress' => 'x@example.org']]] as [$method, $body]) {
                $response = $this->call($method, "/api/accounts/{$other}/identities", $body);
                self::assertSame(404, $response->getStatusCode());
                self::assertSame(['message' => 'Konto nicht gefunden.'], Http::json($response));
            }
        }
        foreach (['not-a-uuid', Uuid::v4(), $foreignIdentity] as $other) {
            foreach ([['PATCH', ['name' => 'x']], ['DELETE', null]] as [$method, $body]) {
                $response = $this->call($method, "/api/identities/{$other}", $body);
                self::assertSame(404, $response->getStatusCode());
                self::assertSame(['message' => 'Identität nicht gefunden.'], Http::json($response));
            }
        }
    }

    /** An account (with one identity) of another user. */
    private function foreignAccount(): string
    {
        $userId = $this->createUser(Uuid::v4() . '@example.net');
        $id = Uuid::v4();
        Database::run(
            self::$db->pdo(),
            "INSERT INTO mail_account (id, user_id, display_name, email_address, imap_host, imap_port, smtp_host, smtp_port, wrapped_dek, key_id, credential_enc)
             VALUES (?, ?, 'Other', 'other@example.net', 'imap.example.net', 993, 'smtp.example.net', 465, 'x', 'v1', 'x')",
            [$id, $userId],
        );
        Database::run(self::$db->pdo(), "INSERT INTO identity (id, account_id, name, email_address) VALUES (?, ?, 'Other', 'other@example.net')", [Uuid::v4(), $id]);

        return $id;
    }
}
