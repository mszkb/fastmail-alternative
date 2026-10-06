<?php

declare(strict_types=1);

namespace Fma\Tests\Unit\Push;

use Fma\Push\Endpoint;
use Fma\Push\PushPayload;
use Fma\Push\Vapid;
use Fma\Push\WebPushCrypto;
use PHPUnit\Framework\TestCase;

final class WebPushTest extends TestCase
{
    private static function b64(string $value): string
    {
        $decoded = WebPushCrypto::base64UrlDecode($value);
        self::assertNotNull($decoded);

        return $decoded;
    }

    /** RFC 8291 section 5 (aes128gcm, rs 4096, single record). */
    public function testRfc8291Vector(): void
    {
        $asPrivate = WebPushCrypto::privateKeyFromRaw(
            self::b64('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'),
            self::b64('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8'),
        );
        $body = WebPushCrypto::encrypt(
            'When I grow up, I want to be a watermelon',
            self::b64('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'),
            self::b64('BTBZMqHH6r4Tts7J_aSIgg'),
            $asPrivate,
            self::b64('DGv6ra1nlYgDCS1FRnbzlw'),
        );
        self::assertSame(
            'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
            WebPushCrypto::base64UrlEncode($body),
        );
    }

    /** The user agent side of RFC 8291 decrypts what encrypt() produces with fresh keys. */
    public function testRoundTripWithFreshKeys(): void
    {
        $ua = WebPushCrypto::generateKey();
        $uaPublic = WebPushCrypto::publicPoint($ua);
        $auth = random_bytes(16);
        $body = WebPushCrypto::encrypt('{"a":1}', $uaPublic, $auth);

        $salt = substr($body, 0, 16);
        self::assertSame(4096, unpack('N', substr($body, 16, 4))[1] ?? null);
        self::assertSame(65, \ord($body[20]));
        $asPublic = substr($body, 21, 65);
        $secret = openssl_pkey_derive(WebPushCrypto::publicKeyFromPoint($asPublic), $ua, 32);
        self::assertIsString($secret);
        $ikm = hash_hkdf('sha256', $secret, 32, "WebPush: info\x00" . $uaPublic . $asPublic, $auth);
        $cek = hash_hkdf('sha256', $ikm, 16, "Content-Encoding: aes128gcm\x00", $salt);
        $nonce = hash_hkdf('sha256', $ikm, 12, "Content-Encoding: nonce\x00", $salt);
        $sealed = substr($body, 86);
        $plain = openssl_decrypt(substr($sealed, 0, -16), 'aes-128-gcm', $cek, OPENSSL_RAW_DATA, $nonce, substr($sealed, -16));
        self::assertSame("{\"a\":1}\x02", $plain);
    }

    public function testVapidJwtVerifiesWithOpenssl(): void
    {
        $key = WebPushCrypto::generateKey();
        $public = WebPushCrypto::base64UrlEncode(WebPushCrypto::publicPoint($key));
        $details = openssl_pkey_get_details($key);
        self::assertIsArray($details);
        $private = WebPushCrypto::base64UrlEncode(str_pad($details['ec']['d'], 32, "\x00", STR_PAD_LEFT));

        $header = (new Vapid($public, $private, 'mailto:ops@example.org'))->authorization('https://push.example.org:8443/send/abc?x=1', 1_000);
        if (preg_match('/^vapid t=([^,]+), k=(.+)$/', $header, $m) !== 1) {
            self::fail('unexpected Authorization header');
        }
        self::assertSame($public, $m[2]);
        [$h, $c, $s] = explode('.', $m[1]);
        self::assertSame(['typ' => 'JWT', 'alg' => 'ES256'], json_decode(self::b64($h), true));
        self::assertSame(['aud' => 'https://push.example.org:8443', 'exp' => 1_000 + 43_200, 'sub' => 'mailto:ops@example.org'], json_decode(self::b64($c), true));
        $raw = self::b64($s);
        self::assertSame(64, \strlen($raw));
        self::assertSame(1, openssl_verify("{$h}.{$c}", WebPushCrypto::rawToDerSignature($raw), WebPushCrypto::publicKeyFromPoint(self::b64($public)), OPENSSL_ALGO_SHA256));
    }

    public function testInvalidVapidKeysAndSubjectThrow(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        (new Vapid('AAAA', 'BBBB'))->authorization('https://push.example.org/x');
    }

    public function testPayloadHasOnlyTypeInstallationIdAndBadge(): void
    {
        $payload = PushPayload::build('11111111-2222-4333-8444-555555555555', -3);
        self::assertSame(['type', 'installationId', 'badge'], array_keys($payload));
        self::assertSame(['type' => 'new_mail', 'installationId' => '11111111-2222-4333-8444-555555555555', 'badge' => 0], $payload);
        self::assertSame('{"type":"new_mail","installationId":"i","badge":7}', PushPayload::json('i', 7));
    }

    public function testEndpointHelpers(): void
    {
        self::assertSame('push.example.org', Endpoint::host('https://Push.Example.org:443/a'));
        self::assertSame('[2001:db8::1]:8443', Endpoint::host('https://[2001:db8::1]:8443/a'));
        self::assertSame('', Endpoint::host('ftp://x/'));
        self::assertNull(Endpoint::parse("https://push.example.org/\u{e4}"));
        self::assertSame('invalid', Endpoint::ref('nope')['pushHost']);
        self::assertSame(12, \strlen(Endpoint::ref('https://a.example/x')['endpointHash']));
    }
}
