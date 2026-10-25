<?php

declare(strict_types=1);

namespace Fma\Auth;

use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * Resolves the session: a bearer token (native clients, #138) when the
 * request carries `Authorization: Bearer`, otherwise the session cookie.
 * Cookie tokens older than 24 hours are rotated; bearer tokens are not, their
 * expiry moves forward with use instead. Other Authorization schemes (e.g.
 * Basic from a reverse proxy) leave the cookie in charge.
 */
final class Authenticator
{
    public function __construct(
        private readonly Sessions $sessions,
        private readonly SessionCookie $cookie,
    ) {}

    /** @return array{?Session, ?string} the session and a new token if it was rotated */
    public function resolve(ServerRequestInterface $request): array
    {
        if (self::hasBearer($request)) {
            $token = self::bearerToken($request);
            $session = $token === null ? null : $this->sessions->resolve($token, Sessions::BEARER);
            if ($session !== null) {
                $this->sessions->touchDevice($session->deviceId);
                $this->sessions->extendBearer($session->sessionId);
            }

            return [$session, null];
        }
        $token = SessionCookie::token($request);
        $session = $token === null ? null : $this->sessions->resolve($token);
        if ($session === null) {
            return [null, null];
        }
        $this->sessions->touchDevice($session->deviceId);
        $rotated = $this->sessions->needsRotation($session) ? $this->sessions->rotate($session->sessionId) : null;

        return [$session, $rotated];
    }

    /** True when the request authenticates with `Authorization: Bearer` (then the cookie is ignored). */
    public static function hasBearer(ServerRequestInterface $request): bool
    {
        return preg_match('/^Bearer(?:\s|$)/i', $request->getHeaderLine('Authorization')) === 1;
    }

    /** The bearer token, or null when the header is malformed. */
    public static function bearerToken(ServerRequestInterface $request): ?string
    {
        $matched = preg_match('/^Bearer +([A-Za-z0-9_-]{1,128})$/i', $request->getHeaderLine('Authorization'), $m);

        return $matched === 1 ? $m[1] : null;
    }

    /** Adds the rotated token unless the handler set the cookie itself. */
    public function finish(ResponseInterface $response, ?string $rotatedToken): ResponseInterface
    {
        if ($rotatedToken === null || SessionCookie::isSetOn($response)) {
            return $response;
        }

        return $this->cookie->set($response, $rotatedToken);
    }
}
