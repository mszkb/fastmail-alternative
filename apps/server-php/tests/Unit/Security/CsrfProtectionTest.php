<?php

declare(strict_types=1);

namespace Fma\Tests\Unit\Security;

use Fma\Http\Middleware\CsrfProtection;
use Fma\Tests\Support\Http;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class CsrfProtectionTest extends TestCase
{
    /** @return iterable<string, array{string, array<string, string>, bool}> */
    public static function cases(): iterable
    {
        yield 'GET is always allowed' => ['GET', ['Sec-Fetch-Site' => 'cross-site'], false];
        yield 'HEAD is always allowed' => ['HEAD', ['Origin' => 'https://evil.example'], false];
        yield 'OPTIONS is always allowed' => ['OPTIONS', ['Sec-Fetch-Site' => 'cross-site'], false];
        yield 'same-origin fetch' => ['POST', ['Sec-Fetch-Site' => 'same-origin'], false];
        yield 'same-site is rejected' => ['POST', ['Sec-Fetch-Site' => 'same-site'], true];
        yield 'cross-site is rejected' => ['DELETE', ['Sec-Fetch-Site' => 'cross-site'], true];
        yield 'none is rejected' => ['POST', ['Sec-Fetch-Site' => 'none'], true];
        yield 'Sec-Fetch-Site wins over Origin' => ['POST', ['Sec-Fetch-Site' => 'cross-site', 'Origin' => 'https://mail.example.org'], true];
        yield 'matching Origin' => ['POST', ['Origin' => 'https://mail.example.org'], false];
        yield 'matching Origin, other case' => ['PATCH', ['Origin' => 'https://MAIL.example.org'], false];
        yield 'foreign Origin' => ['POST', ['Origin' => 'https://evil.example'], true];
        yield 'sibling subdomain' => ['POST', ['Origin' => 'https://evil.mail.example.org'], true];
        yield 'Origin with other port' => ['POST', ['Origin' => 'https://mail.example.org:8443'], true];
        yield 'Origin null' => ['POST', ['Origin' => 'null'], true];
        yield 'no browser headers (curl, native client)' => ['POST', [], false];
    }

    public function testComparesWithTheRawHostIncludingPort(): void
    {
        $request = Http::request('POST', '/api/auth/login', ['Origin' => 'http://127.0.0.1:3102'], ['HTTP_HOST' => '127.0.0.1:3102']);
        self::assertFalse(CsrfProtection::isCrossOrigin($request));
        $request = Http::request('POST', '/api/auth/login', ['Origin' => 'http://127.0.0.1:3102'], ['HTTP_HOST' => '127.0.0.1:3103']);
        self::assertTrue(CsrfProtection::isCrossOrigin($request));
    }

    /** @param array<string, string> $headers */
    #[DataProvider('cases')]
    public function testIsCrossOrigin(string $method, array $headers, bool $expected): void
    {
        self::assertSame($expected, CsrfProtection::isCrossOrigin(Http::request($method, '/api/auth/login', $headers)));
    }
}
