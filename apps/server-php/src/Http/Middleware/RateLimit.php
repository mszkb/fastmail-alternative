<?php

declare(strict_types=1);

namespace Fma\Http\Middleware;

use Fma\Http\Json;
use Fma\Security\ClientIp;
use Fma\Security\RateLimiter;
use Psr\Http\Message\ResponseFactoryInterface;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface;

/**
 * Applies the rate limits before routing and before the body is used, so
 * unmatched requests count against the global limit as well.
 */
final class RateLimit implements MiddlewareInterface
{
    /** @param \Closure(ServerRequestInterface): string $routeOf route pattern or 'unmatched' */
    public function __construct(
        private readonly RateLimiter $limiter,
        private readonly \Closure $routeOf,
        private readonly ResponseFactoryInterface $responses,
    ) {}

    public function process(ServerRequestInterface $request, RequestHandlerInterface $handler): ResponseInterface
    {
        $route = ($this->routeOf)($request);
        $retryAfter = $this->limiter->hit($request->getMethod(), $route, ClientIp::fromRequest($request));
        if ($retryAfter > 0) {
            return Json::write(
                $this->responses->createResponse(),
                ['message' => 'Zu viele Anfragen. Bitte kurz warten und erneut versuchen.'],
                429,
            )->withHeader('Retry-After', (string) $retryAfter);
        }

        return $handler->handle($request);
    }
}
