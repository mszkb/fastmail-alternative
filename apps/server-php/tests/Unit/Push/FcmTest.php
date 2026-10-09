<?php

declare(strict_types=1);

namespace Fma\Tests\Unit\Push;

use Fma\Config;
use Fma\Push\Fcm;
use Fma\Tests\Support\FakeHttpClient;
use PHPUnit\Framework\TestCase;

/** FCM HTTP v1 transport (#139). */
final class FcmTest extends TestCase
{
    public function testNotConfiguredWithoutProjectOrServiceAccount(): void
    {
        self::assertNull(Fcm::fromConfig(Config::fromArray([])));
        self::assertNull(Fcm::fromConfig(Config::fromArray(['FCM_PROJECT_ID' => 'p'])));
        self::assertFalse(Fcm::enabled(Config::fromArray([])));
        self::assertTrue(Fcm::enabled(Config::fromArray(['FCM_PROJECT_ID' => 'p'])));
        $this->expectException(\RuntimeException::class);
        Fcm::fromConfig(Config::fromArray(['FCM_PROJECT_ID' => 'p', 'FCM_SERVICE_ACCOUNT_JSON' => '{"foo":1}']));
    }

    public function testDataOnlyMessageWithoutMailContent(): void
    {
        $message = Fcm::message('tok', 'inst-1', 3);
        self::assertSame([
            'message' => [
                'token' => 'tok',
                'data' => ['event' => 'new_mail', 'installationId' => 'inst-1', 'badge' => '3'],
                'android' => ['priority' => 'high', 'ttl' => '900s'],
            ],
        ], $message);
        self::assertArrayNotHasKey('notification', $message['message']);
    }

    public function testSendsWithASignedJwtAndCachesTheAccessToken(): void
    {
        $account = FakeHttpClient::serviceAccount();
        $http = new FakeHttpClient();
        // Base64 as written to .env.
        $fcm = Fcm::fromConfig(Config::fromArray(['FCM_PROJECT_ID' => 'test-project', 'FCM_SERVICE_ACCOUNT_JSON' => base64_encode($account)]), $http);
        self::assertNotNull($fcm);
        self::assertSame(200, $fcm->send('device-token-1', 'inst-1', 2));
        self::assertSame(200, $fcm->send('device-token-2', 'inst-1', 2));

        self::assertCount(3, $http->calls, 'one token request, two sends');
        parse_str($http->calls[0]['body'], $form);
        self::assertSame('urn:ietf:params:oauth:grant-type:jwt-bearer', $form['grant_type']);
        self::assertIsString($form['assertion']);
        [$header, $claims, $signature] = explode('.', $form['assertion']);
        $decode = static fn(string $s): string => (string) base64_decode(strtr($s, '-_', '+/'), true);
        $claimsJson = json_decode($decode($claims), true);
        self::assertIsArray($claimsJson);
        self::assertSame('push@test-project.iam.gserviceaccount.com', $claimsJson['iss']);
        self::assertSame('https://www.googleapis.com/auth/firebase.messaging', $claimsJson['scope']);
        $privateKey = openssl_pkey_get_private((string) json_decode($account, true)['private_key']);
        self::assertNotFalse($privateKey);
        $details = openssl_pkey_get_details($privateKey);
        self::assertIsArray($details);
        $publicKey = $details['key'];
        self::assertSame(1, openssl_verify("{$header}.{$claims}", $decode($signature), $publicKey, OPENSSL_ALGO_SHA256));

        $send = $http->calls[1];
        self::assertSame('https://fcm.googleapis.com/v1/projects/test-project/messages:send', $send['url']);
        self::assertSame('Bearer ya29.test', $send['headers']['Authorization']);
        self::assertSame(Fcm::message('device-token-1', 'inst-1', 2), json_decode($send['body'], true));
    }

    public function testUnregisteredTokensAreReportedAs404(): void
    {
        $http = new FakeHttpClient([
            ['status' => 404, 'body' => '{"error":{"status":"NOT_FOUND"}}'],
            ['status' => 400, 'body' => '{"error":{"status":"INVALID_ARGUMENT","details":[{"@type":"type.googleapis.com/google.firebase.fcm.v1.FcmError","errorCode":"UNREGISTERED"}]}}'],
            ['status' => 500, 'body' => '{}'],
        ]);
        $fcm = Fcm::fromConfig(Config::fromArray(['FCM_PROJECT_ID' => 'p', 'FCM_SERVICE_ACCOUNT_JSON' => FakeHttpClient::serviceAccount()]), $http);
        self::assertNotNull($fcm);
        self::assertSame(404, $fcm->send('a', 'i', 0));
        self::assertSame(404, $fcm->send('b', 'i', 0));
        self::assertSame(500, $fcm->send('c', 'i', 0));
    }
}
