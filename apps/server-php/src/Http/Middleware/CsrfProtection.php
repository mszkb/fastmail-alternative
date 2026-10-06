<?php

declare(strict_types=1);

namespace Fma\Http\Middleware;

use Fma\Http\Json;
use Psr\Http\Message\ResponseFactoryInterface;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface;

/**
 * CSRF protection without tokens, like apps/api/src/security/csrf.ts:
 * every request other than GET/HEAD/OPTIONS must come from the same origin.
 * - `Sec-Fetch-Site` present: only `same-origin` is accepted.
 * - otherwise `Origin` present: its host must equal the `Host` header.
 * - neither header: not a browser request (curl, native client), allowed.
 * The session cookie is SameSite=Strict on top.
 */
final class CsrfProtection implements MiddlewareInterface
{
    private const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

    public function __construct(private readonly ResponseFactoryInterface $responses) {}

    public static function isCrossOrigin(ServerRequestInterface $request): bool
    {
        if (\in_array($request->getMethod(), self::SAFE_METHODS, true)) {
            return false;
        }
        $fetchSite = $request->getHeaderLine('Sec-Fetch-Site');
        if ($fetchSite !== '') {
            return $fetchSite !== 'same-origin';
        }
        $origin = $request->getHeaderLine('Origin');
        if ($origin !== '') {
            $parts = parse_url($origin);
            if ($parts === false || !isset($parts['scheme'], $parts['host'])) {
                return true; // "null" (sandboxed frames, file://) or garbage
            }
            $originHost = $parts['host'] . (isset($parts['port']) ? ':' . $parts['port'] : '');

            return strtolower($originHost) !== strtolower($request->getHeaderLine('Host'));
        }

        return false;
    }

    public function process(ServerRequestInterface $request, RequestHandlerInterface $handler): ResponseInterface
    {
        if (self::isCrossOrigin($request)) {
            return Json::write($this->responses->createResponse(), ['message' => 'Cross-origin request rejected'], 403);
        }

        return $handler->handle($request);
    }
}
