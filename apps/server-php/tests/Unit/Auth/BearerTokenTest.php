<?php

declare(strict_types=1);

namespace Fma\Tests\Unit\Auth;

use Fma\Auth\BearerToken;
use Fma\Http\Middleware\CsrfProtection;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Slim\Psr7\Factory\ServerRequestFactory;

/** Authorization: Bearer of native clients (#138). */
final class BearerTokenTest extends TestCase
{
    /** @return iterable<string, array{string, bool, ?string}> */
    public static function headers(): iterable
    {
        $token = str_repeat('Ab3_-', 9);
        yield 'valid' => ["Bearer {$token}", true, $token];
        yield 'lower-case scheme' => ["bearer {$token}", true, $token];
        yield 'too short' => ['Bearer abc', true, null];
        yield 'invalid characters' => ['Bearer ' . str_repeat('a', 30) . '!', true, null];
        yield 'basic auth' => ['Basic dXNlcjpwYXNz', false, null];
        yield 'none' => ['', false, null];
    }

    #[DataProvider('headers')]
    public function testParse(string $header, bool $present, ?string $token): void
    {
        $request = (new ServerRequestFactory())->createServerRequest('POST', '/api/sync');
        if ($header !== '') {
            $request = $request->withHeader('Authorization', $header);
        }
        self::assertSame($present, BearerToken::present($request));
        self::assertSame($token, BearerToken::token($request));
    }

    public function testBearerRequestsAreNotCrossOriginChecked(): void
    {
        $request = (new ServerRequestFactory())->createServerRequest('POST', '/api/sync')
            ->withHeader('Sec-Fetch-Site', 'cross-site');
        self::assertTrue(CsrfProtection::isCrossOrigin($request));
        self::assertFalse(CsrfProtection::isCrossOrigin($request->withHeader('Authorization', 'Bearer ' . str_repeat('a', 43))));
    }
}
