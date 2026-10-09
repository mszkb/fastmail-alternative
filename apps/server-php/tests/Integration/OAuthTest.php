<?php

declare(strict_types=1);

namespace Fma\Tests\Integration;

use Fma\App;
use Fma\Auth\Sessions;
use Fma\Config;
use Fma\Crypto\Envelope;
use Fma\Db\Database;
use Fma\Db\Uuid;
use Fma\Jobs\AccountErrorException;
use Fma\Log\Logger;
use Fma\Mail\AccountContext;
use Fma\Mail\FileStore;
use Fma\Mail\HostConfig;
use Fma\Mail\ImapClient;
use Fma\Mail\MailException;
use Fma\Mail\TransportPolicy;
use Fma\Tests\Support\FakeConnectionTester;
use Fma\Tests\Support\FakeTokenClient;
use Fma\Tests\Support\Http;
use Psr\Http\Message\ResponseInterface;

/**
 * Sign-in with Google/Microsoft (#36): start -> provider -> callback creates
 * or renews an account; expired access tokens are refreshed when an account
 * is loaded, a revoked grant marks only that account. The token endpoint is
 * a FakeTokenClient, IMAP/SMTP the FakeConnectionTester; XOAUTH2 on the wire
 * runs against tests/fixtures/fake-imap-server.php.
 */
final class OAuthTest extends DatabaseTestCase
{
    /** @var \Slim\App<\Psr\Container\ContainerInterface|null> */
    private \Slim\App $app;
    private Config $appConfig;
    private string $masterKey;
    private string $userId;
    private string $token;
    private FakeConnectionTester $tester;
    private FakeTokenClient $tokens;
    /** @var resource */
    private $log;

    protected function setUp(): void
    {
        $pdo = self::$db->pdo();
        foreach (['job', 'oauth_state', 'mail_account', '`user`'] as $table) {
            $pdo->exec("DELETE FROM {$table}");
        }
        $this->masterKey = base64_encode(random_bytes(32));
        $this->appConfig = Config::fromArray([
            'DATABASE_URL' => self::$config->get('DATABASE_URL'),
            'DOMAIN' => 'mail.example.org',
            'MASTER_KEY' => $this->masterKey,
            'OAUTH_GOOGLE_CLIENT_ID' => 'google-client',
            'OAUTH_GOOGLE_CLIENT_SECRET' => 'google-secret',
        ]);
        $this->tester = new FakeConnectionTester();
        $this->tokens = new FakeTokenClient();
        $this->log = Http::memoryStream();
        $this->app = App::create($this->appConfig, self::$db, new Logger('api', 'info', $this->log), [], $this->tester, $this->tokens);
        $this->userId = Uuid::v4();
        Database::run($pdo, 'INSERT INTO `user` (id, email, password_hash) VALUES (?, ?, ?)', [$this->userId, 'me@example.org', 'unused']);
        $this->token = (new Sessions(self::$db))->createDeviceWithSession($this->userId, 'Test', 'desktop');
    }

    /** @param array<mixed>|null $body */
    private function call(string $method, string $path, ?array $body = null, bool $auth = true): ResponseInterface
    {
        $request = Http::request($method, $path, ['Sec-Fetch-Site' => 'same-origin']);
        if ($body !== null) {
            $request->getBody()->write(json_encode($body, JSON_THROW_ON_ERROR));
            $request = $request->withHeader('Content-Type', 'application/json');
        }
        if ($auth) {
            $request = $request->withCookieParams(['fma_session' => $this->token]);
        }

        return $this->app->handle($request);
    }

    /** @param array<string, mixed> $body start request body */
    private function start(array $body = []): string
    {
        $response = $this->call('POST', '/api/oauth/google/start', $body);
        self::assertSame(200, $response->getStatusCode(), (string) $response->getBody());
        $url = Http::json($response)['url'];
        \assert(\is_string($url));
        parse_str((string) parse_url($url, PHP_URL_QUERY), $query);
        \assert(\is_string($query['state']));

        return $query['state'];
    }

    /** The browser coming back from the provider: no session cookie (SameSite=Strict). */
    private function returnFromProvider(string $query): ResponseInterface
    {
        return $this->app->handle(Http::request('GET', '/api/oauth/callback?' . $query, ['Sec-Fetch-Site' => 'cross-site']));
    }

    /** @return array<string, string> query of the redirect back to the PWA */
    private static function redirectQuery(ResponseInterface $response): array
    {
        self::assertSame(303, $response->getStatusCode(), (string) $response->getBody());
        $location = $response->getHeaderLine('Location');
        self::assertStringStartsWith('/?', $location);
        parse_str(substr($location, 2), $query);

        /** @var array<string, string> $query */
        return $query;
    }

    private function grant(string $email = 'me@gmail.com', string $access = 'access-1', string $refresh = 'refresh-1'): void
    {
        $this->tokens->respond(200, [
            'access_token' => $access,
            'refresh_token' => $refresh,
            'expires_in' => 3600,
            'id_token' => FakeTokenClient::idToken(['email' => $email]),
        ]);
    }

    /** @return array<string, mixed> */
    private function credentials(string $accountId): array
    {
        /** @var array{wrapped_dek: string, credential_enc: string} $row */
        $row = Database::run(self::$db->pdo(), 'SELECT wrapped_dek, credential_enc FROM mail_account WHERE id = ?', [$accountId])->fetch();
        $dek = Envelope::unwrapAccountKey($this->masterKey, $row['wrapped_dek']);
        $data = json_decode(Envelope::decryptField($dek, $row['credential_enc'], Envelope::credentialAad($accountId)), true, flags: JSON_THROW_ON_ERROR);
        \assert(\is_array($data));

        return $data;
    }

    private function connect(): string
    {
        $this->grant();
        $query = self::redirectQuery($this->returnFromProvider(http_build_query(['state' => $this->start(), 'code' => 'code-1'])));
        self::assertSame('connected', $query['oauth'], json_encode($query, JSON_THROW_ON_ERROR));

        return $query['account'];
    }

    public function testProvidersListsConfiguredProvidersAndRedirectUri(): void
    {
        self::assertSame(401, $this->call('GET', '/api/oauth/providers', auth: false)->getStatusCode());
        $response = $this->call('GET', '/api/oauth/providers');
        self::assertSame(200, $response->getStatusCode());
        self::assertSame([
            'providers' => ['google' => true, 'microsoft' => false],
            'redirectUri' => 'https://mail.example.org/api/oauth/callback',
        ], Http::json($response));
    }

    public function testStartValidatesProviderAndConfiguration(): void
    {
        self::assertSame(401, $this->call('POST', '/api/oauth/google/start', [], auth: false)->getStatusCode());
        self::assertSame(404, $this->call('POST', '/api/oauth/yahoo/start', [])->getStatusCode());
        $response = $this->call('POST', '/api/oauth/microsoft/start', []);
        self::assertSame(409, $response->getStatusCode());
        self::assertSame('NOT_CONFIGURED', Http::json($response)['code']);
        self::assertSame(404, $this->call('POST', '/api/oauth/google/start', ['accountId' => Uuid::v4()])->getStatusCode());
        self::assertSame(404, $this->call('POST', '/api/oauth/google/start', ['accountId' => 'nope'])->getStatusCode());

        $app = App::create(Config::fromArray(['MASTER_KEY' => $this->masterKey, 'DOMAIN' => ':80', 'OAUTH_GOOGLE_CLIENT_ID' => 'id', 'OAUTH_GOOGLE_CLIENT_SECRET' => 's']), self::$db, new Logger('api', 'info', Http::memoryStream()), [], $this->tester, $this->tokens);
        $request = Http::request('POST', '/api/oauth/google/start', ['Sec-Fetch-Site' => 'same-origin'])->withCookieParams(['fma_session' => $this->token]);
        $response = $app->handle($request);
        self::assertSame(409, $response->getStatusCode());
        self::assertSame('NO_PUBLIC_URL', Http::json($response)['code']);
    }

    public function testStartStoresOnlyAHashOfTheState(): void
    {
        $state = $this->start();
        $rows = Database::run(self::$db->pdo(), 'SELECT state_hash, user_id, provider, account_id FROM oauth_state')->fetchAll();
        self::assertCount(1, $rows);
        self::assertSame(hash('sha256', $state, true), $rows[0]['state_hash']);
        self::assertSame($this->userId, $rows[0]['user_id']);
        self::assertSame('google', $rows[0]['provider']);
        self::assertNull($rows[0]['account_id']);
    }

    public function testCallbackCreatesAnOAuthAccount(): void
    {
        $this->tester->capabilities = ['IMAP4rev1', 'IDLE', 'AUTH=XOAUTH2'];
        $accountId = $this->connect();

        // Code exchange with the PKCE verifier, connection test with XOAUTH2.
        self::assertSame('authorization_code', $this->tokens->requests[0]['form']['grant_type']);
        self::assertSame('code-1', $this->tokens->requests[0]['form']['code']);
        self::assertSame('https://mail.example.org/api/oauth/callback', $this->tokens->requests[0]['form']['redirect_uri']);
        self::assertCount(2, $this->tester->calls);
        self::assertSame(['imap.gmail.com', 993, true, 'me@gmail.com', '', 'access-1'], [$this->tester->calls[0]->host, $this->tester->calls[0]->port, $this->tester->calls[0]->secure, $this->tester->calls[0]->user, $this->tester->calls[0]->password, $this->tester->calls[0]->oauthToken]);
        self::assertSame(['smtp.gmail.com', 465, true], [$this->tester->calls[1]->host, $this->tester->calls[1]->port, $this->tester->calls[1]->secure]);

        $account = Http::json($this->call('GET', '/api/accounts'))['accounts'][0];
        \assert(\is_array($account));
        self::assertSame($accountId, $account['id']);
        self::assertSame('me@gmail.com', $account['emailAddress']);
        self::assertSame('oauth2', $account['credentialKind']);
        self::assertSame('google', $account['oauthProvider']);
        self::assertSame('ok', $account['status']);

        $credentials = $this->credentials($accountId);
        self::assertSame('me@gmail.com', $credentials['imapUser']);
        \assert(\is_array($credentials['oauth']));
        self::assertSame(['provider' => 'google', 'refreshToken' => 'refresh-1', 'accessToken' => 'access-1'], array_intersect_key($credentials['oauth'], ['provider' => 1, 'refreshToken' => 1, 'accessToken' => 1]));
        // Tokens only encrypted, never in the row or the log.
        $row = Database::run(self::$db->pdo(), 'SELECT * FROM mail_account WHERE id = ?', [$accountId])->fetch();
        self::assertStringNotContainsString('refresh-1', (string) json_encode(array_map(static fn($v) => \is_string($v) ? bin2hex($v) . $v : $v, (array) $row)));
        rewind($this->log);
        $log = (string) stream_get_contents($this->log);
        self::assertStringNotContainsString('refresh-1', $log);
        self::assertStringNotContainsString('access-1', $log);
        self::assertStringNotContainsString('me@gmail.com', $log);
        self::assertSame(['folder_sync'], Database::run(self::$db->pdo(), 'SELECT type FROM job WHERE account_id = ?', [$accountId])->fetchAll(\PDO::FETCH_COLUMN));
        self::assertSame(0, (int) Database::run(self::$db->pdo(), 'SELECT COUNT(*) FROM oauth_state')->fetchColumn());
    }

    public function testStateIsSingleUseAndExpires(): void
    {
        $state = $this->start();
        $this->grant();
        self::assertSame('connected', self::redirectQuery($this->returnFromProvider(http_build_query(['state' => $state, 'code' => 'c'])))['oauth']);
        self::assertSame(['oauth' => 'error', 'reason' => 'state'], self::redirectQuery($this->returnFromProvider(http_build_query(['state' => $state, 'code' => 'c']))));
        self::assertSame(['oauth' => 'error', 'reason' => 'state'], self::redirectQuery($this->returnFromProvider('code=c')));

        $old = $this->start();
        Database::run(self::$db->pdo(), 'UPDATE oauth_state SET created_at = UTC_TIMESTAMP(6) - INTERVAL 11 MINUTE');
        self::assertSame(['oauth' => 'error', 'reason' => 'state'], self::redirectQuery($this->returnFromProvider(http_build_query(['state' => $old, 'code' => 'c']))));
        self::assertCount(1, $this->tokens->requests);
    }

    public function testDeniedConsentAndProviderErrors(): void
    {
        self::assertSame(['oauth' => 'error', 'reason' => 'denied'], self::redirectQuery($this->returnFromProvider(http_build_query(['state' => $this->start(), 'error' => 'access_denied']))));

        $this->tokens->respond(400, ['error' => 'invalid_grant']);
        self::assertSame(['oauth' => 'error', 'reason' => 'invalid_grant'], self::redirectQuery($this->returnFromProvider(http_build_query(['state' => $this->start(), 'code' => 'c']))));

        // Without a refresh token the account could not sync later.
        $this->tokens->respond(200, ['access_token' => 'a', 'id_token' => FakeTokenClient::idToken(['email' => 'me@gmail.com'])]);
        self::assertSame(['oauth' => 'error', 'reason' => 'no_refresh_token'], self::redirectQuery($this->returnFromProvider(http_build_query(['state' => $this->start(), 'code' => 'c']))));

        $this->grant();
        $this->tester->imapCode = 'AUTH_FAILED';
        self::assertSame(['oauth' => 'error', 'reason' => 'imap', 'code' => 'AUTH_FAILED'], self::redirectQuery($this->returnFromProvider(http_build_query(['state' => $this->start(), 'code' => 'c']))));
        self::assertSame(0, (int) Database::run(self::$db->pdo(), 'SELECT COUNT(*) FROM mail_account')->fetchColumn());
    }

    public function testSigningInAgainRenewsTheAccount(): void
    {
        $accountId = $this->connect();
        Database::run(self::$db->pdo(), "UPDATE mail_account SET status = 'auth_error', last_error_code = 'OAUTH_EXPIRED', error_count = 3 WHERE id = ?", [$accountId]);
        Database::run(self::$db->pdo(), 'DELETE FROM job');

        $state = $this->start(['accountId' => strtoupper($accountId)]);
        $url = Database::run(self::$db->pdo(), 'SELECT account_id FROM oauth_state')->fetchColumn();
        self::assertSame($accountId, $url);
        $this->grant('me@gmail.com', 'access-2', 'refresh-2');
        $query = self::redirectQuery($this->returnFromProvider(http_build_query(['state' => $state, 'code' => 'c'])));
        self::assertSame(['oauth' => 'connected', 'account' => $accountId], $query);

        $row = Database::run(self::$db->pdo(), 'SELECT status, last_error_code, error_count FROM mail_account WHERE id = ?', [$accountId])->fetch();
        self::assertSame(['status' => 'ok', 'last_error_code' => null, 'error_count' => 0], array_map(static fn($v) => is_numeric($v) ? (int) $v : $v, (array) $row));
        $oauth = $this->credentials($accountId)['oauth'];
        \assert(\is_array($oauth));
        self::assertSame('refresh-2', $oauth['refreshToken']);
        self::assertSame(1, (int) Database::run(self::$db->pdo(), 'SELECT COUNT(*) FROM mail_account')->fetchColumn());
        self::assertSame(['folder_sync'], Database::run(self::$db->pdo(), 'SELECT type FROM job')->fetchAll(\PDO::FETCH_COLUMN));

        // Without accountId the same address also renews instead of duplicating.
        $this->grant('ME@gmail.com', 'access-3', 'refresh-3');
        self::assertSame(['oauth' => 'connected', 'account' => $accountId], self::redirectQuery($this->returnFromProvider(http_build_query(['state' => $this->start(), 'code' => 'c']))));
        self::assertSame(1, (int) Database::run(self::$db->pdo(), 'SELECT COUNT(*) FROM mail_account')->fetchColumn());
    }

    public function testSigningInAgainWithAnotherMailboxIsRefused(): void
    {
        $accountId = $this->connect();
        $state = $this->start(['accountId' => $accountId]);
        $this->grant('other@gmail.com', 'access-2', 'refresh-2');
        self::assertSame(['oauth' => 'error', 'reason' => 'wrong_account'], self::redirectQuery($this->returnFromProvider(http_build_query(['state' => $state, 'code' => 'c']))));
        $oauth = $this->credentials($accountId)['oauth'];
        \assert(\is_array($oauth));
        self::assertSame('refresh-1', $oauth['refreshToken']);
    }

    public function testHostsOfOAuthAccountsCannotBeChanged(): void
    {
        $accountId = $this->connect();
        $response = $this->call('PATCH', "/api/accounts/{$accountId}", ['imap' => ['host' => 'evil.example.org', 'port' => 993, 'user' => 'x', 'password' => 'y']]);
        self::assertSame(400, $response->getStatusCode());
        self::assertSame(200, $this->call('PATCH', "/api/accounts/{$accountId}", ['displayName' => 'Gmail'])->getStatusCode());
    }

    public function testExpiredAccessTokenIsRefreshedWhenTheAccountIsLoaded(): void
    {
        $accountId = $this->connect();
        $context = AccountContext::load(self::$db->pdo(), $accountId, $this->appConfig, $this->tokens);
        self::assertSame('access-1', $context->imap->oauthToken);
        self::assertCount(1, $this->tokens->requests);

        $this->expire($accountId);
        $this->tokens->respond(200, ['access_token' => 'access-2', 'expires_in' => 3600]);
        $context = AccountContext::load(self::$db->pdo(), $accountId, $this->appConfig, $this->tokens);
        self::assertSame('access-2', $context->imap->oauthToken);
        self::assertSame('access-2', $context->smtp->oauthToken);
        self::assertSame('me@gmail.com', $context->smtp->user);
        self::assertSame(['grant_type' => 'refresh_token', 'refresh_token' => 'refresh-1', 'client_id' => 'google-client', 'client_secret' => 'google-secret'], $this->tokens->requests[1]['form']);
        $oauth = $this->credentials($accountId)['oauth'];
        \assert(\is_array($oauth));
        // No new refresh token in the answer: the old one stays.
        self::assertSame(['access-2', 'refresh-1'], [$oauth['accessToken'], $oauth['refreshToken']]);
        self::assertFalse(self::$db->pdo()->inTransaction());
    }

    public function testRevokedGrantFailsOnlyThatAccount(): void
    {
        $accountId = $this->connect();
        $this->expire($accountId);
        $this->tokens->respond(400, ['error' => 'invalid_grant']);
        $this->assertLoadFails($accountId, 'OAUTH_EXPIRED', 'auth');

        // A provider outage is temporary (backoff, no new sign-in).
        $this->tokens->responses[] = 'network';
        $this->assertLoadFails($accountId, 'TIMEOUT', 'unreachable');

        // Provider removed from the configuration.
        $this->assertLoadFails($accountId, 'OAUTH_NOT_CONFIGURED', 'auth', Config::fromArray(['MASTER_KEY' => $this->masterKey]));
        self::assertFalse(self::$db->pdo()->inTransaction());
    }

    private function expire(string $accountId): void
    {
        $credentials = $this->credentials($accountId);
        \assert(\is_array($credentials['oauth']));
        $credentials['oauth']['expiresAt'] = time() + 30;
        /** @var string $wrapped */
        $wrapped = Database::run(self::$db->pdo(), 'SELECT wrapped_dek FROM mail_account WHERE id = ?', [$accountId])->fetchColumn();
        $dek = Envelope::unwrapAccountKey($this->masterKey, $wrapped);
        Database::run(self::$db->pdo(), 'UPDATE mail_account SET credential_enc = ? WHERE id = ?', [
            Envelope::encryptField($dek, json_encode($credentials, JSON_THROW_ON_ERROR), Envelope::credentialAad($accountId)),
            $accountId,
        ]);
    }

    private function assertLoadFails(string $accountId, string $code, string $kind, ?Config $config = null): void
    {
        try {
            AccountContext::load(self::$db->pdo(), $accountId, $config ?? $this->appConfig, $this->tokens);
            self::fail("expected {$code}");
        } catch (AccountErrorException $e) {
            self::assertSame($code, $e->errorCode);
            self::assertSame($kind, $e->kind());
        }
    }

    public function testImportedOAuthAccountWaitsForANewSignIn(): void
    {
        $file = [
            'format' => 'fma-config',
            'version' => 1,
            'exportedAt' => '2026-10-01T00:00:00.000Z',
            'settings' => [],
            'accounts' => [[
                'displayName' => 'Gmail',
                'emailAddress' => 'me@gmail.com',
                'credentialKind' => 'oauth2',
                'oauthProvider' => 'google',
                'imap' => ['host' => 'imap.gmail.com', 'port' => 993, 'user' => 'me@gmail.com'],
                'smtp' => ['host' => 'smtp.gmail.com', 'port' => 465, 'user' => 'me@gmail.com'],
                'identities' => [],
                'folderRoles' => [],
            ]],
        ];
        $response = $this->call('POST', '/api/import/config', $file);
        self::assertSame(200, $response->getStatusCode(), (string) $response->getBody());
        /** @var array{id: string, credential_kind: string, oauth_provider: ?string, status: string, last_error_code: ?string} $row */
        $row = Database::run(self::$db->pdo(), 'SELECT id, credential_kind, oauth_provider, status, last_error_code FROM mail_account')->fetch();
        self::assertSame(['oauth2', 'google', 'auth_error', 'OAUTH_EXPIRED'], [$row['credential_kind'], $row['oauth_provider'], $row['status'], $row['last_error_code']]);

        // "Neu anmelden" picks it up.
        $state = $this->start(['accountId' => $row['id']]);
        $this->grant();
        self::assertSame(['oauth' => 'connected', 'account' => $row['id']], self::redirectQuery($this->returnFromProvider(http_build_query(['state' => $state, 'code' => 'c']))));
    }

    public function testImapClientAuthenticatesWithXoauth2(): void
    {
        $dir = sys_get_temp_dir() . '/fma-xoauth2-' . bin2hex(random_bytes(4));
        mkdir($dir);
        touch("{$dir}/commands.log");
        $process = null;
        try {
            foreach (['IMAP4rev1 SASL-IR AUTH=XOAUTH2', 'IMAP4rev1 AUTH=XOAUTH2'] as $capabilities) {
                file_put_contents("{$dir}/state.json", json_encode(['capabilities' => $capabilities, 'highestModseq' => null, 'uids' => [], 'oauthUser' => 'me@gmail.com', 'oauthToken' => 'good-token'], JSON_THROW_ON_ERROR));
                $process = proc_open([\PHP_BINARY, __DIR__ . '/../fixtures/fake-imap-server.php', "{$dir}/state.json", "{$dir}/commands.log"], [1 => ['pipe', 'w'], 2 => ['file', '/dev/null', 'w']], $pipes);
                self::assertIsResource($process);
                stream_set_timeout($pipes[1], 5);
                if (preg_match('/^PORT (\d+)$/', trim((string) fgets($pipes[1])), $m) !== 1) {
                    self::fail('fake IMAP server did not start');
                }
                $policy = new TransportPolicy(allowPrivateHosts: true, insecureTransport: true);
                $config = static fn(string $token): HostConfig => new HostConfig('127.0.0.1', (int) $m[1], false, 'me@gmail.com', '', $token);

                $client = ImapClient::connect($policy, $config('good-token'), 5.0);
                $client->logout();
                try {
                    ImapClient::connect($policy, $config('bad-token'), 5.0);
                    self::fail('expected AUTH_FAILED');
                } catch (MailException $e) {
                    self::assertSame('AUTH_FAILED', $e->errorCode);
                }
                proc_terminate($process);
                proc_close($process);
                $process = null;
            }
            $log = (string) file_get_contents("{$dir}/commands.log");
            self::assertSame(4, substr_count($log, 'AUTHENTICATE XOAUTH2'));
            self::assertStringNotContainsString('LOGIN', $log);
        } finally {
            if (\is_resource($process)) {
                proc_terminate($process);
                proc_close($process);
            }
            FileStore::removeTree($dir);
        }
    }
}
