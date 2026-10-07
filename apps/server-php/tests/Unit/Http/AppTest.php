<?php

declare(strict_types=1);

namespace Fma\Tests\Unit\Http;

use Fma\App;
use Fma\Config;
use Fma\Http\Middleware\SecurityHeaders;
use Fma\Log\Logger;
use Fma\Tests\Support\Http;
use PHPUnit\Framework\TestCase;

/** App behaviour that needs no database (rate limits off, unreachable DB). */
final class AppTest extends TestCase
{
    /** @var resource */
    private $log;

    protected function setUp(): void
    {
        $this->log = Http::memoryStream();
    }

    /**
     * @param array<string, string> $config
     *
     * @return \Slim\App<\Psr\Container\ContainerInterface|null>
     */
    private function app(array $config = []): \Slim\App
    {
        // Port 1 on loopback: connection refused immediately.
        $config += ['DATABASE_URL' => 'mysql://nobody:secret-db-password@127.0.0.1:1/mail', 'APP_VERSION' => '1.2.3'];

        return App::create(Config::fromArray($config), logger: new Logger('api', 'debug', $this->log), rateLimits: []);
    }

    public function testHealthReportsDatabaseDownWith503(): void
    {
        $response = Http::call($this->app(), 'GET', '/api/health');
        self::assertSame(503, $response->getStatusCode());
        self::assertSame(
            ['status' => 'degraded', 'service' => 'api', 'version' => '1.2.3', 'checks' => ['database' => 'down']],
            Http::json($response),
        );
        self::assertStringNotContainsString('secret-db-password', Http::contents($this->log));
    }

    public function testSecurityHeadersOnEveryResponse(): void
    {
        foreach (['/api/health', '/api/does-not-exist'] as $path) {
            $response = Http::call($this->app(), 'GET', $path);
            foreach (SecurityHeaders::HEADERS as $name => $value) {
                self::assertSame($value, $response->getHeaderLine($name), "{$name} on {$path}");
            }
        }
    }

    public function testUnknownRouteIsJson404(): void
    {
        $response = Http::call($this->app(), 'GET', '/api/nope');
        self::assertSame(404, $response->getStatusCode());
        self::assertSame(['message' => 'Not Found'], Http::json($response));
    }

    public function testWrongMethodIs405(): void
    {
        $response = Http::call($this->app(), 'DELETE', '/api/health');
        self::assertSame(405, $response->getStatusCode());
        self::assertSame('GET', $response->getHeaderLine('Allow'));
    }

    public function testMetricsDisabledWithoutToken(): void
    {
        $response = Http::call($this->app(), 'GET', '/api/metrics');
        self::assertSame(404, $response->getStatusCode());
        self::assertSame(['message' => 'Not found'], Http::json($response));
    }

    public function testMetricsRejectsWrongToken(): void
    {
        $app = $this->app(['METRICS_TOKEN' => 'let-me-in']);
        self::assertSame(401, Http::call($app, 'GET', '/api/metrics')->getStatusCode());
        self::assertSame(401, Http::call($app, 'GET', '/api/metrics', ['Authorization' => 'Bearer wrong'])->getStatusCode());
    }

    public function testCrossOriginPostIsRejectedBeforeRouting(): void
    {
        $response = Http::call($this->app(), 'POST', '/api/health', ['Sec-Fetch-Site' => 'cross-site']);
        self::assertSame(403, $response->getStatusCode());
        self::assertSame(['message' => 'Cross-origin request rejected'], Http::json($response));
    }

    public function testRequestLogHasNoQueryString(): void
    {
        Http::call($this->app(), 'GET', '/api/nope?q=secret+search');
        $log = Http::contents($this->log);
        self::assertStringContainsString('"url":"/api/nope"', $log);
        self::assertStringNotContainsString('secret', $log);
    }
}
