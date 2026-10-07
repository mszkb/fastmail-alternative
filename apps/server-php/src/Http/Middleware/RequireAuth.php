<?php

declare(strict_types=1);

namespace Fma\Http\Middleware;

use Fma\Auth\Authenticator;
use Fma\Http\Json;
use Psr\Http\Message\ResponseFactoryInterface;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface;

/**
 * Route middleware for authenticated routes: 401 before the body is used,
 * otherwise the session is available as request attribute `auth`.
 */
final class RequireAuth implements MiddlewareInterface
{
    public function __construct(
        private readonly Authenticator $auth,
        private readonly ResponseFactoryInterface $responses,
    ) {}

    public function process(ServerRequestInterface $request, RequestHandlerInterface $handler): ResponseInterface
    {
        [$session, $rotatedToken] = $this->auth->resolve($request);
        if ($session === null) {
            return Json::write($this->responses->createResponse(), ['message' => 'Not authenticated'], 401);
        }

        return $this->auth->finish($handler->handle($request->withAttribute('auth', $session)), $rotatedToken);
    }
}
