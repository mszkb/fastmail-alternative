<?php

declare(strict_types=1);

namespace Fma\Tests\Integration;

use Fma\App;
use Fma\Auth\Sessions;
use Fma\Config;
use Fma\Db\Database;
use Fma\Db\Uuid;
use Fma\Log\Logger;
use Fma\Tests\Support\Http;
use Psr\Http\Message\ResponseInterface;

final class AuthTest extends DatabaseTestCase
{
    /** PHC string created by another Argon2id implementation (hash-wasm; m=19456, t=2, p=1). */
    private const FOREIGN_HASH = '$argon2id$v=19$m=19456,t=2,p=1$BwcHBwcHBwcHBwcHBwcHBw$IKTQ7IZ/DDTn5kzWh8hSs7Til6OOKiVHqoEdW1tVAig';
    private const FOREIGN_PASSWORD = 'node-hashed-password';

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
    }

    /**
     * @param array<mixed>|null $body
     * @param array<string, string> $headers
     */
    private function call(string $method, string $path, ?array $body = null, ?string $token = null, string $ip = '198.51.100.20', array $headers = ['Sec-Fetch-Site' => 'same-origin']): ResponseInterface
    {
        $request = Http::request($method, $path, $headers + ['X-Forwarded-For' => $ip], ['REMOTE_ADDR' => '127.0.0.1']);
        if ($body !== null) {
            $request->getBody()->write(json_encode($body, JSON_THROW_ON_ERROR));
            $request = $request->withHeader('Content-Type', 'application/json');
        }
        if ($token !== null) {
            $request = $request->withCookieParams(['fma_session' => $token]);
        }

        return $this->app->handle($request);
    }

    private static function token(ResponseInterface $response): ?string
    {
        foreach ($response->getHeader('Set-Cookie') as $cookie) {
            if (preg_match('/^fma_session=([^;]*)/', $cookie, $m) === 1) {
                return $m[1];
            }
        }

        return null;
    }

    private function createUserWithForeignHash(): void
    {
        Database::run(self::$db->pdo(), 'INSERT INTO `user` (id, email, password_hash) VALUES (?, ?, ?)', [Uuid::v4(), 'ref@example.org', self::FOREIGN_HASH]);
    }

    private function login(string $ip = '198.51.100.20'): string
    {
        $response = $this->call('POST', '/api/auth/login', ['email' => 'Ref@Example.org ', 'password' => self::FOREIGN_PASSWORD, 'platform' => 'ios_pwa'], ip: $ip);
        self::assertSame(200, $response->getStatusCode());
        $token = self::token($response);
        self::assertNotNull($token);

        return $token;
    }

    public function testLoginWithAHashFromAnotherArgon2idImplementation(): void
    {
        $this->createUserWithForeignHash();
        $response = $this->call('POST', '/api/auth/login', ['email' => 'ref@example.org', 'password' => self::FOREIGN_PASSWORD]);
        self::assertSame(200, $response->getStatusCode());
        self::assertSame(['email' => 'ref@example.org'], Http::json($response));
        $cookie = $response->getHeaderLine('Set-Cookie');
        self::assertMatchesRegularExpression('/^fma_session=[A-Za-z0-9_-]{43}; Max-Age=2592000; Path=\/; HttpOnly; Secure; SameSite=Strict$/', $cookie);
        // Only the SHA-256 of the token is stored.
        $stored = Database::run(self::$db->pdo(), 'SELECT token_hash FROM session')->fetchColumn();
        self::assertSame(hash('sha256', (string) self::token($response), true), $stored);
    }

    public function testSetupStoresAnArgon2idHashAndClosesItself(): void
    {
        $code = $this->setupCode();
        $response = $this->call('POST', '/api/auth/setup', ['email' => 'Me@Example.org', 'password' => 'long-enough-1', 'setupCode' => strtolower(str_replace('-', ' ', $code))]);
        self::assertSame(200, $response->getStatusCode(), (string) $response->getBody());
        self::assertSame(['email' => 'me@example.org'], Http::json($response));
        $hash = (string) Database::run(self::$db->pdo(), 'SELECT password_hash FROM `user`')->fetchColumn();
        self::assertStringStartsWith('$argon2id$v=19$m=19456,t=2,p=1$', $hash);
        self::assertSame(0, (int) Database::run(self::$db->pdo(), 'SELECT COUNT(*) FROM app_state')->fetchColumn(), 'code discarded');
        self::assertSame(403, $this->call('POST', '/api/auth/setup', ['email' => 'x@example.org', 'password' => 'long-enough-1', 'setupCode' => $code])->getStatusCode());
    }

    /** The generated code is logged once; returns it. */
    private function setupCode(): string
    {
        $this->call('GET', '/api/auth/status');
        $this->call('GET', '/api/auth/status');
        $log = Http::contents($this->log);
        self::assertSame(1, preg_match_all('/FIRST-RUN SETUP CODE: ([A-Z2-7]{4}(?:-[A-Z2-7]{4}){5})/', $log, $m));

        return $m[1][0];
    }

    public function testSetupRejectsWrongCodeAndWeakPassword(): void
    {
        $code = $this->setupCode();
        self::assertSame(403, $this->call('POST', '/api/auth/setup', ['email' => 'me@example.org', 'password' => 'long-enough-1', 'setupCode' => 'AAAA'])->getStatusCode());
        self::assertSame(400, $this->call('POST', '/api/auth/setup', ['email' => 'me@example.org', 'password' => 'short', 'setupCode' => $code])->getStatusCode());
        self::assertSame(400, $this->call('POST', '/api/auth/setup', ['email' => 'not-an-email', 'password' => 'long-enough-1', 'setupCode' => $code])->getStatusCode());
    }

    public function testInvalidJsonIs400(): void
    {
        $request = Http::request('POST', '/api/auth/login', ['Content-Type' => 'application/json']);
        $request->getBody()->write('{nope');
        self::assertSame(400, $this->app->handle($request)->getStatusCode());
    }

    public function testLockoutAfterFiveFailedLogins(): void
    {
        $this->createUserWithForeignHash();
        for ($i = 0; $i < 5; ++$i) {
            self::assertSame(401, $this->call('POST', '/api/auth/login', ['email' => 'ref@example.org', 'password' => 'wrong-password-x'], ip: '198.51.100.30')->getStatusCode());
        }
        $locked = $this->call('POST', '/api/auth/login', ['email' => 'ref@example.org', 'password' => self::FOREIGN_PASSWORD], ip: '198.51.100.30');
        self::assertSame(429, $locked->getStatusCode());
        self::assertSame(['message' => 'Too many failed attempts. Try again in 15 minutes.'], Http::json($locked));
        self::assertSame('900', $locked->getHeaderLine('Retry-After'));
        // Other clients are not affected.
        $this->login('198.51.100.31');
        self::assertStringNotContainsString('wrong-password', Http::contents($this->log));
        self::assertStringNotContainsString('ref@example.org', Http::contents($this->log));
    }

    public function testTokenRotatesAfter24HoursAndIdleSessionsExpire(): void
    {
        $this->createUserWithForeignHash();
        $token = $this->login();
        self::assertNull(self::token($this->call('GET', '/api/auth/devices', token: $token)), 'fresh token is not rotated');

        Database::run(self::$db->pdo(), 'UPDATE session SET rotated_at = UTC_TIMESTAMP(6) - INTERVAL 25 HOUR');
        $response = $this->call('GET', '/api/auth/devices', token: $token);
        self::assertSame(200, $response->getStatusCode());
        $rotated = self::token($response);
        self::assertNotNull($rotated);
        self::assertNotSame($token, $rotated);
        self::assertSame(401, $this->call('GET', '/api/auth/devices', token: $token)->getStatusCode(), 'old token invalid');
        self::assertSame(200, $this->call('GET', '/api/auth/devices', token: $rotated)->getStatusCode());

        Database::run(self::$db->pdo(), 'UPDATE session SET rotated_at = UTC_TIMESTAMP(6) - INTERVAL 15 DAY');
        self::assertSame(401, $this->call('GET', '/api/auth/devices', token: $rotated)->getStatusCode(), 'idle');

        Database::run(self::$db->pdo(), 'UPDATE session SET rotated_at = UTC_TIMESTAMP(6), expires_at = UTC_TIMESTAMP(6) - INTERVAL 1 SECOND');
        self::assertSame(401, $this->call('GET', '/api/auth/devices', token: $rotated)->getStatusCode(), 'absolute timeout');
    }

    public function testPasswordChangeEndsOtherDevicesAndRotatesTheToken(): void
    {
        $this->createUserWithForeignHash();
        $other = $this->login();
        $current = $this->login();
        $devices = Http::json($this->call('GET', '/api/auth/devices', token: $current))['devices'];
        self::assertIsArray($devices);
        self::assertCount(2, $devices);
        self::assertTrue($devices[0]['isCurrent']);
        self::assertSame('ios_pwa', $devices[0]['platform']);
        self::assertMatchesRegularExpression('/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/', $devices[0]['lastSeenAt']);

        self::assertSame(403, $this->call('POST', '/api/auth/password', ['currentPassword' => 'wrong', 'newPassword' => 'new-password-1'], $current)->getStatusCode());
        self::assertSame(400, $this->call('POST', '/api/auth/password', ['currentPassword' => self::FOREIGN_PASSWORD, 'newPassword' => 'short'], $current)->getStatusCode());
        $changed = $this->call('POST', '/api/auth/password', ['currentPassword' => self::FOREIGN_PASSWORD, 'newPassword' => 'new-password-1'], $current);
        self::assertSame(204, $changed->getStatusCode());
        $newToken = self::token($changed);
        self::assertNotNull($newToken);
        self::assertSame(401, $this->call('GET', '/api/auth/devices', token: $other)->getStatusCode());
        self::assertSame(401, $this->call('GET', '/api/auth/devices', token: $current)->getStatusCode());
        self::assertCount(1, (array) Http::json($this->call('GET', '/api/auth/devices', token: $newToken))['devices']);
        self::assertSame(200, $this->call('POST', '/api/auth/login', ['email' => 'ref@example.org', 'password' => 'new-password-1'])->getStatusCode());
    }

    public function testRevokeDeviceAndLogout(): void
    {
        $this->createUserWithForeignHash();
        $other = $this->login();
        $current = $this->login();
        $devices = (array) Http::json($this->call('GET', '/api/auth/devices', token: $current))['devices'];
        $otherId = $devices[1]['id'];
        self::assertSame(409, $this->call('DELETE', '/api/auth/devices/' . $devices[0]['id'], token: $current)->getStatusCode());
        self::assertSame(404, $this->call('DELETE', '/api/auth/devices/not-a-uuid', token: $current)->getStatusCode());
        self::assertSame(204, $this->call('DELETE', "/api/auth/devices/{$otherId}", token: $current)->getStatusCode());
        self::assertSame(404, $this->call('DELETE', "/api/auth/devices/{$otherId}", token: $current)->getStatusCode());
        self::assertSame(401, $this->call('GET', '/api/auth/devices', token: $other)->getStatusCode());

        $logout = $this->call('DELETE', '/api/auth/session', token: $current);
        self::assertSame(204, $logout->getStatusCode());
        self::assertSame('', self::token($logout));
        self::assertStringContainsString('Max-Age=0', $logout->getHeaderLine('Set-Cookie'));
        self::assertSame(['needsSetup' => false, 'authenticated' => false], Http::json($this->call('GET', '/api/auth/status', token: $current)));
    }

    /** Native client (#138): login without Origin headers, as an app sends it. */
    private function nativeLogin(): string
    {
        $response = $this->call('POST', '/api/auth/login', [
            'email' => 'ref@example.org', 'password' => self::FOREIGN_PASSWORD,
            'client' => 'native', 'deviceName' => 'Pixel 8', 'platform' => 'android',
        ], headers: []);
        self::assertSame(200, $response->getStatusCode());
        self::assertSame([], $response->getHeader('Set-Cookie'), 'no cookie for native clients');
        $body = Http::json($response);
        self::assertSame('ref@example.org', $body['email']);
        self::assertIsString($body['token']);
        self::assertMatchesRegularExpression('/^[A-Za-z0-9_-]{43}$/', $body['token']);

        return $body['token'];
    }

    /**
     * @param array<mixed>|null $body
     * @param array<string, string> $headers
     */
    private function bearer(string $method, string $path, string $token, ?array $body = null, array $headers = []): ResponseInterface
    {
        return $this->call($method, $path, $body, headers: $headers + ['Authorization' => "Bearer {$token}"]);
    }

    public function testNativeLoginReturnsABearerTokenStoredOnlyAsHash(): void
    {
        $this->createUserWithForeignHash();
        $token = $this->nativeLogin();
        $row = Database::run(self::$db->pdo(), 'SELECT token_hash, client FROM session')->fetch();
        self::assertIsArray($row);
        self::assertSame('native', $row['client']);
        self::assertSame(hash('sha256', $token, true), $row['token_hash']);
        self::assertStringNotContainsString($token, Http::contents($this->log));

        $status = Http::json($this->bearer('GET', '/api/auth/status', $token));
        self::assertSame(['needsSetup' => false, 'authenticated' => true, 'email' => 'ref@example.org'], $status);
        $devices = (array) Http::json($this->bearer('GET', '/api/auth/devices', $token))['devices'];
        self::assertCount(1, $devices);
        self::assertSame('Pixel 8', $devices[0]['name']);
        self::assertSame('android', $devices[0]['platform']);
        self::assertTrue($devices[0]['isCurrent']);

        // Never rotated, no idle timeout; the absolute lifetime still applies.
        Database::run(self::$db->pdo(), 'UPDATE session SET rotated_at = UTC_TIMESTAMP(6) - INTERVAL 60 DAY');
        $response = $this->bearer('GET', '/api/auth/devices', $token);
        self::assertSame(200, $response->getStatusCode());
        self::assertSame([], $response->getHeader('Set-Cookie'));
        Database::run(self::$db->pdo(), 'UPDATE session SET expires_at = UTC_TIMESTAMP(6) - INTERVAL 1 SECOND');
        self::assertSame(401, $this->bearer('GET', '/api/auth/devices', $token)->getStatusCode());
    }

    public function testBearerAndCookieTokensAreNotInterchangeable(): void
    {
        $this->createUserWithForeignHash();
        $native = $this->nativeLogin();
        $web = $this->login();
        self::assertSame(401, $this->call('GET', '/api/auth/devices', token: $native)->getStatusCode(), 'native token as cookie');
        self::assertSame(401, $this->bearer('GET', '/api/auth/devices', $web)->getStatusCode(), 'web token as bearer');
        self::assertSame(401, $this->bearer('GET', '/api/auth/devices', 'not a token')->getStatusCode());
        // With a Bearer header the cookie is never used, even if valid.
        $request = Http::request('GET', '/api/auth/devices', ['Authorization' => 'Bearer ' . str_repeat('a', 43)])->withCookieParams(['fma_session' => $web]);
        self::assertSame(401, $this->app->handle($request)->getStatusCode());
    }

    public function testBearerRequestsSkipTheCsrfCheck(): void
    {
        $this->createUserWithForeignHash();
        $token = $this->nativeLogin();
        $crossSite = ['Sec-Fetch-Site' => 'cross-site', 'Origin' => 'https://evil.example'];
        // A cookie request from another origin is rejected, a Bearer request is not.
        self::assertSame(403, $this->call('DELETE', '/api/auth/session', token: $this->login(), headers: $crossSite)->getStatusCode());
        self::assertSame(204, $this->bearer('DELETE', '/api/auth/session', $token, headers: $crossSite)->getStatusCode());
        self::assertSame(401, $this->bearer('GET', '/api/auth/devices', $token)->getStatusCode(), 'logged out');
    }

    public function testNativeTokenIsRevokableAndEndsWithPasswordChange(): void
    {
        $this->createUserWithForeignHash();
        $native = $this->nativeLogin();
        $web = $this->login();
        $devices = (array) Http::json($this->call('GET', '/api/auth/devices', token: $web))['devices'];
        self::assertCount(2, $devices);
        $nativeId = $devices[1]['id'];
        Database::run(
            self::$db->pdo(),
            "INSERT INTO push_subscription (id, device_id, transport, endpoint, keys_enc) VALUES (?, ?, 'fcm', 'fcm-token', '')",
            [Uuid::v4(), $nativeId],
        );
        self::assertSame(204, $this->call('DELETE', "/api/auth/devices/{$nativeId}", token: $web)->getStatusCode());
        self::assertSame(401, $this->bearer('GET', '/api/auth/devices', $native)->getStatusCode());
        self::assertSame(0, (int) Database::run(self::$db->pdo(), 'SELECT COUNT(*) FROM push_subscription')->fetchColumn());

        // Password change from the app keeps its own token and ends all others.
        $native = $this->nativeLogin();
        $changed = $this->bearer('POST', '/api/auth/password', $native, ['currentPassword' => self::FOREIGN_PASSWORD, 'newPassword' => 'new-password-1']);
        self::assertSame(204, $changed->getStatusCode());
        self::assertSame([], $changed->getHeader('Set-Cookie'));
        self::assertSame(200, $this->bearer('GET', '/api/auth/devices', $native)->getStatusCode());
        self::assertSame(401, $this->call('GET', '/api/auth/devices', token: $web)->getStatusCode());
    }

    public function testTokenFormat(): void
    {
        self::assertMatchesRegularExpression('/^[A-Za-z0-9_-]{43}$/', Sessions::generateToken());
    }
}
