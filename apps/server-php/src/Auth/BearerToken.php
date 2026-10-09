<?php

declare(strict_types=1);

namespace Fma\Auth;

use Psr\Http\Message\ServerRequestInterface;

/**
 * `Authorization: Bearer <token>` of native clients (#138). A request that
 * carries the header is authenticated by it alone, never by a cookie, so
 * it needs no CSRF check (browsers cannot attach the header cross-origin
 * without a CORS preflight, which this API never allows).
 */
final class BearerToken
{
    public static function present(ServerRequestInterface $request): bool
    {
        return preg_match('/^Bearer\s/i', $request->getHeaderLine('Authorization')) === 1;
    }

    /** The token, or null when absent or malformed. */
    public static function token(ServerRequestInterface $request): ?string
    {
        if (preg_match('/^Bearer\s+([A-Za-z0-9_-]{20,128})$/i', trim($request->getHeaderLine('Authorization')), $m) !== 1) {
            return null;
        }

        return $m[1];
    }
}
