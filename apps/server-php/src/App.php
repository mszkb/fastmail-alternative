<?php

declare(strict_types=1);

namespace Fma;

use Fma\Db\Database;
use Fma\Http\ErrorHandler;
use Fma\Http\Json;
use Fma\Http\Middleware\CsrfProtection;
use Fma\Http\Middleware\RateLimit;
use Fma\Http\Middleware\RequestLog;
use Fma\Http\Middleware\SecurityHeaders;
use Fma\Log\Logger;
use Fma\Security\RateLimiter;
use Fma\Security\RateLimitRule;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Slim\App as SlimApp;
use Slim\Factory\AppFactory;
use Slim\Routing\RoutingResults;

/**
 * Builds the Slim app (ADR-0013). All routes live under /api/* with the
 * same paths, status codes and JSON shapes as apps/api, so the PWA works
 * unchanged.
 *
 * Middleware order (outermost first): request log/metrics, security
 * headers, error handler, rate limits, CSRF, routing - rejected requests
 * are answered before authentication or body parsing.
 */
final class App
{
    /**
     * @param list<RateLimitRule>|null $rateLimits defaults to RateLimitRule::defaults()
     *
     * @return SlimApp<\Psr\Container\ContainerInterface|null>
     */
    public static function create(
        Config $config,
        ?Database $db = null,
        ?Logger $logger = null,
        ?array $rateLimits = null,
    ): SlimApp {
        $db ??= new Database($config);
        $logger ??= new Logger('api', $config->get('LOG_LEVEL', 'info'));
        $app = AppFactory::create();
        $responses = $app->getResponseFactory();
        $metrics = $config->get('METRICS_TOKEN') !== '' ? new Metrics($db) : null;

        $resolver = $app->getRouteResolver();
        $routeOf = static function (ServerRequestInterface $request) use ($resolver): string {
            $results = $resolver->computeRoutingResults($request->getUri()->getPath(), $request->getMethod());
            if ($results->getRouteStatus() !== RoutingResults::FOUND || $results->getRouteIdentifier() === null) {
                return 'unmatched';
            }

            return $resolver->resolveRoute($results->getRouteIdentifier())->getPattern();
        };

        self::routes($app, $config, $db, $logger, $metrics);

        // Slim runs the middleware added last first.
        $app->addRoutingMiddleware();
        $app->add(new CsrfProtection($responses));
        $app->add(new RateLimit(new RateLimiter($db, $rateLimits ?? RateLimitRule::defaults()), $routeOf, $responses));
        $errors = $app->addErrorMiddleware(false, false, false);
        $errors->setDefaultErrorHandler(new ErrorHandler($responses, $logger));
        $app->add(new SecurityHeaders());
        $app->add(new RequestLog($logger, $metrics, $routeOf));

        return $app;
    }

    /** @param SlimApp<\Psr\Container\ContainerInterface|null> $app */
    private static function routes(SlimApp $app, Config $config, Database $db, Logger $logger, ?Metrics $metrics): void
    {
        // Liveness/readiness: ok only when the database is reachable.
        $app->get('/api/health', static function (ServerRequestInterface $request, ResponseInterface $response) use ($config, $db, $logger): ResponseInterface {
            $database = 'ok';
            try {
                $db->pdo()->query('SELECT 1');
            } catch (\Throwable $e) {
                $database = 'down';
                $logger->warn('health check: database unreachable', ['errName' => $e::class]);
            }

            return Json::write($response, [
                'status' => $database === 'ok' ? 'ok' : 'degraded',
                'service' => 'api',
                'version' => $config->version(),
                'checks' => ['database' => $database],
            ], $database === 'ok' ? 200 : 503);
        });

        // Prometheus metrics, disabled (404) unless METRICS_TOKEN is set.
        $app->get('/api/metrics', static function (ServerRequestInterface $request, ResponseInterface $response) use ($config, $metrics): ResponseInterface {
            $expected = $config->get('METRICS_TOKEN');
            if ($expected === '' || $metrics === null) {
                return Json::write($response, ['message' => 'Not found'], 404);
            }
            // Constant-time comparison of equal-length digests.
            $given = $request->getHeaderLine('Authorization');
            if (!hash_equals(hash('sha256', "Bearer {$expected}"), hash('sha256', $given))) {
                return Json::write($response, ['message' => 'Invalid metrics token'], 401);
            }
            $response->getBody()->write($metrics->render());

            return $response->withHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
        });
    }
}
