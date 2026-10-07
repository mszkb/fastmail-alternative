<?php

declare(strict_types=1);

namespace Fma\Auth;

use Fma\Config;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * The session cookie `fma_session` (HttpOnly, SameSite=Strict, Path=/), as
 * set by apps/api. `Secure` unless the instance is plain HTTP
 * (`DOMAIN=:80`); COOKIE_SECURE=1/0 overrides.
 */
final class SessionCookie
{
    public const NAME = 'fma_session';

    public function __construct(private readonly Config $config) {}

    public function secure(): bool
    {
        $override = $this->config->get('COOKIE_SECURE');
        if ($override === '1' || $override === '0') {
            return $override === '1';
        }

        return $this->config->get('DOMAIN', ':80') !== ':80';
    }

    public static function token(ServerRequestInterface $request): ?string
    {
        $token = $request->getCookieParams()[self::NAME] ?? null;

        return \is_string($token) && $token !== '' && \strlen($token) <= 128 ? $token : null;
    }

    public function set(ResponseInterface $response, string $token): ResponseInterface
    {
        return $this->withCookie($response, self::NAME . '=' . $token . '; Max-Age=' . Sessions::TTL_SECONDS);
    }

    public function clear(ResponseInterface $response): ResponseInterface
    {
        return $this->withCookie($response, self::NAME . '=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
    }

    public static function isSetOn(ResponseInterface $response): bool
    {
        foreach ($response->getHeader('Set-Cookie') as $cookie) {
            if (str_starts_with($cookie, self::NAME . '=')) {
                return true;
            }
        }

        return false;
    }

    private function withCookie(ResponseInterface $response, string $value): ResponseInterface
    {
        return $response->withAddedHeader(
            'Set-Cookie',
            $value . '; Path=/; HttpOnly' . ($this->secure() ? '; Secure' : '') . '; SameSite=Strict',
        );
    }
}
