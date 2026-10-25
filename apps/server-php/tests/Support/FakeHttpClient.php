<?php

declare(strict_types=1);

namespace Fma\Tests\Support;

use Fma\Push\HttpClient;

/** Records requests; answers the OAuth token endpoint and FCM sends from a script. */
final class FakeHttpClient implements HttpClient
{
    /** @var list<array{url: string, headers: array<string, string>, body: string}> */
    public array $calls = [];

    /** @param list<array{status: int, body: string}> $fcmResponses answered in order, then 200 */
    public function __construct(public array $fcmResponses = []) {}

    public function post(string $url, array $headers, string $body): array
    {
        $this->calls[] = ['url' => $url, 'headers' => $headers, 'body' => $body];
        if ($url === 'https://oauth2.googleapis.com/token') {
            return ['status' => 200, 'body' => '{"access_token":"ya29.test","expires_in":3599,"token_type":"Bearer"}'];
        }

        return array_shift($this->fcmResponses) ?? ['status' => 200, 'body' => '{"name":"projects/p/messages/1"}'];
    }

    /** @return list<array{url: string, headers: array<string, string>, body: string}> */
    public function sends(): array
    {
        return array_values(array_filter($this->calls, static fn(array $c): bool => str_starts_with($c['url'], 'https://fcm.googleapis.com/')));
    }

    /** A service account JSON with a fresh RSA key, as FCM_SERVICE_ACCOUNT_JSON. */
    public static function serviceAccount(): string
    {
        $key = openssl_pkey_new(['private_key_bits' => 2048, 'private_key_type' => OPENSSL_KEYTYPE_RSA]);
        \assert($key !== false);
        openssl_pkey_export($key, $pem);

        return json_encode(['type' => 'service_account', 'client_email' => 'push@test-project.iam.gserviceaccount.com', 'private_key' => $pem], JSON_THROW_ON_ERROR);
    }
}
