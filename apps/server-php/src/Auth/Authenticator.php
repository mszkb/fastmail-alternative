<?php

declare(strict_types=1);

namespace Fma\Auth;

use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/** Resolves the session cookie and rotates tokens older than 24 hours. */
final class Authenticator
{
    public function __construct(
        private readonly Sessions $sessions,
        private readonly SessionCookie $cookie,
    ) {}

    /** @return array{?Session, ?string} the session and a new token if it was rotated */
    public function resolve(ServerRequestInterface $request): array
    {
        $token = SessionCookie::token($request);
        $session = $token === null ? null : $this->sessions->resolve($token);
        if ($session === null) {
            return [null, null];
        }
        $this->sessions->touchDevice($session->deviceId);
        $rotated = $this->sessions->needsRotation($session) ? $this->sessions->rotate($session->sessionId) : null;

        return [$session, $rotated];
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
