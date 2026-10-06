<?php

declare(strict_types=1);

namespace Fma\Tests\Integration;

use Fma\App;
use Fma\Config;
use Fma\Db\Database;
use Fma\Db\Migrator;
use Fma\Log\Logger;
use Fma\Security\LoginLockout;
use Fma\Security\RateLimiter;
use Fma\Security\RateLimitRule;
use Fma\Tests\Support\Http;

final class RuntimeStateTest extends DatabaseTestCase
{
    protected function setUp(): void
    {
        self::$db->pdo()->exec('DELETE FROM rate_limit');
        self::$db->pdo()->exec('DELETE FROM login_lockout');
        self::$db->pdo()->exec('DELETE FROM metric_counter');
    }

    /**
     * @param list<RateLimitRule>|null $rules
     *
     * @return \Slim\App<\Psr\Container\ContainerInterface|null>
     */
    private function app(?array $rules = null, string $metricsToken = ''): \Slim\App
    {
        $config = Config::fromArray([
            'DATABASE_URL' => self::$config->get('DATABASE_URL'),
            'METRICS_TOKEN' => $metricsToken,
        ]);

        return App::create($config, self::$db, new Logger('api', 'error', Http::memoryStream()), $rules);
    }

    public function testMigrationsAreIdempotent(): void
    {
        self::assertSame([], (new Migrator(self::$db->pdo(), __DIR__ . '/../../migrations'))->migrate());
    }

    public function testHealthOkWithDatabase(): void
    {
        $response = Http::call($this->app([]), 'GET', '/api/health');
        self::assertSame(200, $response->getStatusCode());
        self::assertSame('ok', Http::json($response)['status']);
    }

    public function testRateLimitAnswers429WithRetryAfter(): void
    {
        $app = $this->app([new RateLimitRule('global', 3), new RateLimitRule('auth', 1, 'POST', ['/api/health'])]);
        for ($i = 0; $i < 3; ++$i) {
            self::assertSame(200, Http::call($app, 'GET', '/api/health')->getStatusCode());
        }
        $limited = Http::call($app, 'GET', '/api/health');
        self::assertSame(429, $limited->getStatusCode());
        self::assertSame(['message' => 'Zu viele Anfragen. Bitte kurz warten und erneut versuchen.'], Http::json($limited));
        $retryAfter = (int) $limited->getHeaderLine('Retry-After');
        self::assertGreaterThanOrEqual(1, $retryAfter);
        self::assertLessThanOrEqual(60, $retryAfter);
        // Another client IP has its own counter; unmatched routes count too.
        self::assertSame(404, Http::call($app, 'GET', '/api/nope', server: ['REMOTE_ADDR' => '198.51.100.1'])->getStatusCode());
    }

    public function testRulesWithTheSameNameShareOneCounter(): void
    {
        $limiter = new RateLimiter(self::$db, [
            new RateLimitRule('account-test', 2, 'POST', ['/api/accounts']),
            new RateLimitRule('account-test', 2, 'PATCH', ['/api/accounts/{id}']),
        ]);
        $now = 1_700_000_000;
        self::assertSame(0, $limiter->hit('POST', '/api/accounts', '192.0.2.1', $now));
        self::assertSame(0, $limiter->hit('PATCH', '/api/accounts/{id}', '192.0.2.1', $now));
        self::assertSame(40, $limiter->hit('POST', '/api/accounts', '192.0.2.1', $now)); // window ends at ...040
        self::assertSame(0, $limiter->hit('POST', '/api/accounts', '192.0.2.1', $now + 60), 'next window');
        $limiter->prune($now + 60);
        self::assertSame(1, (int) Database::run(self::$db->pdo(), 'SELECT COUNT(*) FROM rate_limit')->fetchColumn());
    }

    public function testLoginLockoutAfterFiveFailures(): void
    {
        $lockout = new LoginLockout(self::$db);
        $ip = '192.0.2.50';
        $now = 1_700_000_000;
        for ($i = 1; $i <= 4; ++$i) {
            self::assertFalse($lockout->recordFail($ip, $now + $i));
        }
        self::assertSame(0, $lockout->isLockedOut($ip, $now + 4));
        self::assertTrue($lockout->recordFail($ip, $now + 5));
        self::assertSame(900, $lockout->isLockedOut($ip, $now + 5));
        self::assertFalse($lockout->recordFail($ip, $now + 6), 'already locked');
        self::assertSame(0, $lockout->isLockedOut($ip, $now + 905));
        self::assertSame(0, $lockout->isLockedOut('192.0.2.51', $now), 'other IP');

        $lockout->recordSuccess($ip);
        self::assertSame(0, $lockout->isLockedOut($ip, $now + 6));
    }

    public function testLockoutWindowExpires(): void
    {
        $lockout = new LoginLockout(self::$db);
        $now = 1_700_000_000;
        for ($i = 0; $i < 4; ++$i) {
            $lockout->recordFail('192.0.2.60', $now);
        }
        // Window of 15 minutes is over: counting restarts.
        self::assertFalse($lockout->recordFail('192.0.2.60', $now + 901));
        self::assertFalse($lockout->recordFail('192.0.2.60', $now + 902));
        $lockout->prune($now + 2000);
        self::assertSame(0, (int) Database::run(self::$db->pdo(), 'SELECT COUNT(*) FROM login_lockout')->fetchColumn());
    }

    public function testMetricsWithToken(): void
    {
        $app = $this->app([], 'let-me-in');
        Http::call($app, 'GET', '/api/health');
        Http::call($app, 'GET', '/api/nope');
        $response = Http::call($app, 'GET', '/api/metrics', ['Authorization' => 'Bearer let-me-in']);
        self::assertSame(200, $response->getStatusCode());
        self::assertSame('text/plain; version=0.0.4; charset=utf-8', $response->getHeaderLine('Content-Type'));
        $body = (string) $response->getBody();
        self::assertStringContainsString('http_requests_total{method="GET",route="/api/health",status="200"} 1', $body);
        self::assertStringContainsString('http_requests_total{method="GET",route="unmatched",status="404"} 1', $body);
        self::assertStringContainsString('http_request_duration_seconds_count 2', $body);
        self::assertMatchesRegularExpression('/le="10"\} 2\n.*le="\+Inf"\} 2\nhttp_request_duration_seconds_sum [0-9.eE-]+\nhttp_request_duration_seconds_count 2\n$/s', $body);
    }
}
