<?php

declare(strict_types=1);

namespace Fma\Tests\Integration;

use Fma\App;
use Fma\Auth\Password;
use Fma\Auth\Sessions;
use Fma\Config;
use Fma\Db\Database;
use Fma\Db\Uuid;
use Fma\Log\Logger;
use Fma\Tests\Support\Http;
use Psr\Http\Message\ResponseInterface;

/** Device-bound bearer tokens for native clients (#138). */
final class NativeTokenTest extends DatabaseTestCase
{
    private const PASSWORD = 'native-password-1';

    /** @var \Slim\App<\Psr\Container\ContainerInterface|null> */
    private \Slim\App $app;

    /** @var resource */
    private $log;

    protected function setUp(): void
    {
        $pdo = self::$db->pdo();
        foreach (['`user`', 'login_lockout', 'app_state'] as $table) {
            $pdo->exec("DELETE FROM {$table}");
        }
        $this->log = Http::memoryStream();
        $config = Config::fromArray(['DATABASE_URL' => self::$config->get('DATABASE_URL'), 'DOMAIN' => 'mail.example.org']);
        $this->app = App::create($config, self::$db, new Logger('api', 'info', $this->log), []);
        Database::run($pdo, 'INSERT INTO `user` (id, email, password_hash) VALUES (?, ?, ?)', [Uuid::v4(), 'me@example.org', Password::hash(self::PASSWORD)]);
    }

    /**
     * A request like a native app sends it: no Sec-Fetch-Site/Origin.
     *
     * @param array<mixed>|null $body
     * @param array<string, string> $headers
     */
    private function call(string $method, string $path, ?array $body = null, ?string $bearer = null, ?string $cookie = null, array $headers = []): ResponseInterface
    {
        $request = Http::request($method, $path, $headers + ($bearer !== null ? ['Authorization' => "Bearer {$bearer}"] : []));
        if ($body !== null) {
            $request->getBody()->write(json_encode($body, JSON_THROW_ON_ERROR));
            $request = $request->withHeader('Content-Type', 'application/json');
        }
        if ($cookie !== null) {
            $request = $request->withCookieParams(['fma_session' => $cookie]);
        }

        return $this->app->handle($request);
    }

    private function nativeLogin(string $platform = 'ios'): string
    {
        $response = $this->call('POST', '/api/auth/login', ['email' => 'me@example.org', 'password' => self::PASSWORD, 'client' => 'native', 'deviceName' => 'iPhone', 'platform' => $platform]);
        self::assertSame(200, $response->getStatusCode());
        $token = Http::json($response)['token'];
        self::assertIsString($token);

        return $token;
    }

    private function cookieLogin(): string
    {
        $response = $this->call('POST', '/api/auth/login', ['email' => 'me@example.org', 'password' => self::PASSWORD], headers: ['Sec-Fetch-Site' => 'same-origin']);
        self::assertSame(200, $response->getStatusCode());
        if (preg_match('/^fma_session=([^;]+)/', $response->getHeaderLine('Set-Cookie'), $m) !== 1) {
            self::fail('no session cookie');
        }

        return $m[1];
    }

    public function testNativeLoginReturnsABearerTokenInsteadOfTheCookie(): void
    {
        $response = $this->call('POST', '/api/auth/login', ['email' => 'Me@Example.org', 'password' => self::PASSWORD, 'client' => 'native', 'deviceName' => 'iPhone', 'platform' => 'ios']);
        self::assertSame(200, $response->getStatusCode());
        self::assertSame([], $response->getHeader('Set-Cookie'));
        self::assertStringContainsString('no-store', $response->getHeaderLine('Cache-Control'));
        $body = Http::json($response);
        self::assertSame('me@example.org', $body['email']);
        self::assertIsString($body['token']);
        self::assertMatchesRegularExpression('/^[A-Za-z0-9_-]{43}$/', $body['token']);
        $token = $body['token'];

        // Only the hash is stored, the token never reaches the log.
        $row = Database::run(self::$db->pdo(), 'SELECT token_hash, kind FROM session')->fetch();
        self::assertIsArray($row);
        self::assertSame(Sessions::hashToken($token), $row['token_hash']);
        self::assertSame('bearer', $row['kind']);
        self::assertStringNotContainsString($token, Http::contents($this->log));

        self::assertSame(['needsSetup' => false, 'authenticated' => true, 'email' => 'me@example.org'], Http::json($this->call('GET', '/api/auth/status', bearer: $token)));
        $devices = (array) Http::json($this->call('GET', '/api/auth/devices', bearer: $token))['devices'];
        self::assertCount(1, $devices);
        self::assertSame(['iPhone', 'ios', true], [$devices[0]['name'], $devices[0]['platform'], $devices[0]['isCurrent']]);
        self::assertSame('android', Http::json($this->call('GET', '/api/auth/devices', bearer: $this->nativeLogin('android')))['devices'][0]['platform']);
    }

    public function testNativeLoginNeedsANativePlatformAndCountsWrongPasswords(): void
    {
        foreach ([null, 'ios_pwa', 'desktop'] as $platform) {
            $response = $this->call('POST', '/api/auth/login', ['email' => 'me@example.org', 'password' => self::PASSWORD, 'client' => 'native', 'platform' => $platform]);
            self::assertSame(400, $response->getStatusCode(), (string) $platform);
        }
        self::assertFalse(Database::run(self::$db->pdo(), 'SELECT 1 FROM login_lockout')->fetchColumn(), 'a client bug is no failed login');

        $wrong = $this->call('POST', '/api/auth/login', ['email' => 'me@example.org', 'password' => 'wrong-password', 'client' => 'native', 'platform' => 'ios']);
        self::assertSame(401, $wrong->getStatusCode());
        self::assertArrayNotHasKey('token', Http::json($wrong));
        // A browser cannot pick a native platform.
        $this->cookieLogin();
        $browser = $this->call('POST', '/api/auth/login', ['email' => 'me@example.org', 'password' => self::PASSWORD, 'platform' => 'ios'], headers: ['Sec-Fetch-Site' => 'same-origin']);
        self::assertSame(200, $browser->getStatusCode());
        self::assertNotContains('ios', array_column(Database::run(self::$db->pdo(), 'SELECT platform FROM device')->fetchAll(), 'platform'));
    }

    public function testATokenIsOnlyAcceptedTheWayItWasIssued(): void
    {
        $bearer = $this->nativeLogin();
        $cookie = $this->cookieLogin();
        self::assertSame(401, $this->call('GET', '/api/auth/devices', cookie: $bearer)->getStatusCode(), 'bearer token as cookie');
        self::assertSame(401, $this->call('GET', '/api/auth/devices', bearer: $cookie)->getStatusCode(), 'cookie token as bearer');
        // With a Bearer header the cookie is ignored, also when the header is malformed.
        self::assertSame(401, $this->call('GET', '/api/auth/devices', cookie: $cookie, headers: ['Authorization' => 'Bearer'])->getStatusCode());
        self::assertSame(401, $this->call('GET', '/api/auth/devices', cookie: $cookie, headers: ['Authorization' => 'Bearer a b'])->getStatusCode());
        // Other schemes (Basic auth of a reverse proxy) leave the cookie in charge.
        self::assertSame(200, $this->call('GET', '/api/auth/devices', cookie: $cookie, headers: ['Authorization' => 'Basic dXNlcjpwdw=='])->getStatusCode());
        self::assertSame(200, $this->call('GET', '/api/auth/devices', headers: ['Authorization' => "bearer  {$bearer}"])->getStatusCode(), 'scheme is case-insensitive');
    }

    public function testBearerTokensAreNotRotatedAndExpireAfter90DaysWithoutUse(): void
    {
        $token = $this->nativeLogin();
        $pdo = self::$db->pdo();
        Database::run($pdo, 'UPDATE session SET rotated_at = UTC_TIMESTAMP(6) - INTERVAL 60 DAY');
        $response = $this->call('GET', '/api/auth/devices', bearer: $token);
        self::assertSame(200, $response->getStatusCode(), 'no 14-day idle rule for bearer tokens');
        self::assertSame([], $response->getHeader('Set-Cookie'), 'never rotated');

        // Use moves the expiry forward (at most once a day).
        Database::run($pdo, 'UPDATE session SET expires_at = UTC_TIMESTAMP(6) + INTERVAL 1 DAY');
        self::assertSame(200, $this->call('GET', '/api/auth/devices', bearer: $token)->getStatusCode());
        $left = (int) Database::run($pdo, 'SELECT TIMESTAMPDIFF(DAY, UTC_TIMESTAMP(6), expires_at) FROM session')->fetchColumn();
        self::assertGreaterThanOrEqual(89, $left);

        Database::run($pdo, 'UPDATE session SET expires_at = UTC_TIMESTAMP(6) - INTERVAL 1 SECOND');
        self::assertSame(401, $this->call('GET', '/api/auth/devices', bearer: $token)->getStatusCode());
    }

    public function testRevokedTokenIs401AndItsPushSubscriptionIsGone(): void
    {
        $bearer = $this->nativeLogin();
        $cookie = $this->cookieLogin();
        $pdo = self::$db->pdo();
        $nativeDevice = (string) Database::run($pdo, "SELECT id FROM device WHERE platform = 'ios'")->fetchColumn();
        Database::run($pdo, "INSERT INTO push_subscription (id, device_id, transport, endpoint, keys_enc) VALUES (?, ?, 'webpush', 'https://push.example.org/x', 'k')", [Uuid::v4(), $nativeDevice]);

        self::assertSame(204, $this->call('DELETE', "/api/auth/devices/{$nativeDevice}", cookie: $cookie, headers: ['Sec-Fetch-Site' => 'same-origin'])->getStatusCode());
        self::assertSame(401, $this->call('GET', '/api/auth/devices', bearer: $bearer)->getStatusCode());
        self::assertFalse(Database::run($pdo, 'SELECT 1 FROM push_subscription')->fetchColumn());
    }

    public function testPasswordChangeKeepsTheBearerTokenAndRevokesTheOthers(): void
    {
        $other = $this->nativeLogin('android');
        $cookie = $this->cookieLogin();
        $bearer = $this->nativeLogin();
        $changed = $this->call('POST', '/api/auth/password', ['currentPassword' => self::PASSWORD, 'newPassword' => 'native-password-2'], bearer: $bearer);
        self::assertSame(204, $changed->getStatusCode());
        self::assertSame([], $changed->getHeader('Set-Cookie'));
        self::assertSame(200, $this->call('GET', '/api/auth/devices', bearer: $bearer)->getStatusCode());
        self::assertSame(401, $this->call('GET', '/api/auth/devices', bearer: $other)->getStatusCode());
        self::assertSame(401, $this->call('GET', '/api/auth/devices', cookie: $cookie)->getStatusCode());
    }

    public function testBearerRequestsSkipTheOriginCheckAndLogOut(): void
    {
        $bearer = $this->nativeLogin();
        $cookie = $this->cookieLogin();
        $crossSite = ['Sec-Fetch-Site' => 'cross-site', 'Origin' => 'https://evil.example'];
        self::assertSame(403, $this->call('DELETE', '/api/auth/session', cookie: $cookie, headers: $crossSite)->getStatusCode());

        $logout = $this->call('DELETE', '/api/auth/session', bearer: $bearer, headers: $crossSite);
        self::assertSame(204, $logout->getStatusCode());
        self::assertSame([], $logout->getHeader('Set-Cookie'));
        self::assertSame(401, $this->call('GET', '/api/auth/devices', bearer: $bearer)->getStatusCode());
        self::assertSame(200, $this->call('GET', '/api/auth/devices', cookie: $cookie)->getStatusCode());
    }
}
