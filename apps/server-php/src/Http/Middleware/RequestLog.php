<?php

declare(strict_types=1);

namespace Fma\Http\Middleware;

use Fma\Log\Logger;
use Fma\Metrics;
use Fma\Security\ClientIp;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface;

/**
 * Outermost middleware: logs each request (path without query string -
 * queries may carry search terms) and records metrics when enabled.
 */
final class RequestLog implements MiddlewareInterface
{
    /** @param \Closure(ServerRequestInterface): string $routeOf */
    public function __construct(
        private readonly Logger $logger,
        private readonly ?Metrics $metrics,
        private readonly \Closure $routeOf,
    ) {}

    public function process(ServerRequestInterface $request, RequestHandlerInterface $handler): ResponseInterface
    {
        $start = hrtime(true);
        $response = $handler->handle($request);
        $seconds = (hrtime(true) - $start) / 1e9;
        $this->logger->info('request completed', [
            'req' => [
                'method' => $request->getMethod(),
                'url' => $request->getUri()->getPath(),
                'remoteAddress' => ClientIp::fromRequest($request),
            ],
            'res' => ['statusCode' => $response->getStatusCode()],
            'responseTime' => round($seconds * 1000, 3),
        ]);
        if ($this->metrics !== null) {
            try {
                $this->metrics->recordRequest($request->getMethod(), ($this->routeOf)($request), $response->getStatusCode(), $seconds);
            } catch (\Throwable $e) {
                $this->logger->warn('metrics not recorded', ['errName' => $e::class]);
            }
        }

        return $response;
    }
}
