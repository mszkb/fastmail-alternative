<?php

declare(strict_types=1);

namespace Fma\Tests\Unit\Auth;

use Fma\Auth\SessionCookie;
use Fma\Config;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Slim\Psr7\Factory\ResponseFactory;

/** `Secure` flag of the session cookie (ASVS 3.4.1, N7). */
final class SessionCookieTest extends TestCase
{
    /** @return iterable<string, array{array<string, string>, bool}> */
    public static function cases(): iterable
    {
        yield 'own domain' => [['DOMAIN' => 'mail.example.org'], true];
        yield 'plain HTTP on :80' => [['DOMAIN' => ':80'], false];
        yield 'no DOMAIN' => [[], false];
        yield 'own TLS proxy in front of :80' => [['DOMAIN' => ':80', 'COOKIE_SECURE' => '1'], true];
        yield 'forced off' => [['DOMAIN' => 'mail.example.org', 'COOKIE_SECURE' => '0'], false];
        yield 'invalid override is ignored' => [['DOMAIN' => 'mail.example.org', 'COOKIE_SECURE' => 'yes'], true];
    }

    /** @param array<string, string> $env */
    #[DataProvider('cases')]
    public function testSecureFlag(array $env, bool $secure): void
    {
        $cookie = new SessionCookie(Config::fromArray($env));
        self::assertSame($secure, $cookie->secure());
        $header = $cookie->set((new ResponseFactory())->createResponse(), 'token')->getHeaderLine('Set-Cookie');
        self::assertStringStartsWith('fma_session=token; ', $header);
        self::assertStringContainsString('HttpOnly', $header);
        self::assertStringContainsString('SameSite=Strict', $header);
        self::assertSame($secure, str_contains($header, '; Secure'));
    }
}
