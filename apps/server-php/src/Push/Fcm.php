<?php

declare(strict_types=1);

namespace Fma\Push;

use Fma\Config;

/**
 * Firebase Cloud Messaging, HTTP v1 API (#139), for the Android app:
 * - service account from the environment only (FCM_SERVICE_ACCOUNT_JSON,
 *   raw or base64, or FCM_SERVICE_ACCOUNT_FILE), project FCM_PROJECT_ID;
 *   the private key is a secret and never logged;
 * - OAuth2 access token via a self-signed RS256 JWT (scope
 *   firebase.messaging), cached in the process until shortly before expiry;
 * - data-only message with ONLY event type, installation id and badge
 *   (principle 4), Android priority high (new mail only), TTL 15 min;
 * - send() returns the HTTP status; an unregistered token is reported as
 *   404 so the handler deletes the subscription like a 404/410 Web Push.
 */
final class Fcm
{
    private const TOKEN_URL = 'https://oauth2.googleapis.com/token';
    private const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
    private const TOKEN_LIFETIME = 3600;

    private ?string $accessToken = null;
    private int $accessTokenExpires = 0;

    private function __construct(
        private readonly string $projectId,
        private readonly string $clientEmail,
        private readonly string $privateKey,
        private readonly HttpClient $http,
    ) {}

    /** Null when FCM is not configured (FCM_PROJECT_ID or the service account missing). */
    public static function fromConfig(Config $config, ?HttpClient $http = null): ?self
    {
        $projectId = trim($config->get('FCM_PROJECT_ID'));
        $json = trim($config->get('FCM_SERVICE_ACCOUNT_JSON'));
        $file = trim($config->get('FCM_SERVICE_ACCOUNT_FILE'));
        if ($json === '' && $file !== '' && is_readable($file)) {
            $json = trim((string) file_get_contents($file));
        }
        if ($projectId === '' || $json === '') {
            return null;
        }
        if (!str_starts_with($json, '{')) {
            $json = (string) base64_decode($json, true);
        }
        $account = json_decode($json, true);
        if (!\is_array($account) || !\is_string($account['client_email'] ?? null) || !\is_string($account['private_key'] ?? null)) {
            throw new \RuntimeException('FCM service account is invalid (expected the JSON key file of a service account)');
        }

        return new self($projectId, $account['client_email'], $account['private_key'], $http ?? new StreamHttpClient());
    }

    /** Whether the API should accept FCM registrations (the worker holds the key). */
    public static function enabled(Config $config): bool
    {
        return trim($config->get('FCM_PROJECT_ID')) !== '';
    }

    /**
     * The FCM data message: data values must be strings.
     *
     * @return array{message: array{token: string, data: array{event: string, installationId: string, badge: string}, android: array{priority: string, ttl: string}}}
     */
    public static function message(string $token, string $installationId, int $badge): array
    {
        $payload = PushPayload::build($installationId, $badge);

        return ['message' => [
            'token' => $token,
            'data' => ['event' => $payload['type'], 'installationId' => $payload['installationId'], 'badge' => (string) $payload['badge']],
            'android' => ['priority' => 'high', 'ttl' => PushNotifyHandler::TTL_SECONDS . 's'],
        ]];
    }

    public function send(string $token, string $installationId, int $badge): int
    {
        $response = $this->http->post(
            'https://fcm.googleapis.com/v1/projects/' . rawurlencode($this->projectId) . '/messages:send',
            ['Authorization' => 'Bearer ' . $this->accessToken(), 'Content-Type' => 'application/json'],
            json_encode(self::message($token, $installationId, $badge), JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES),
        );
        if ($response['status'] === 401) {
            $this->accessToken = null; // expired early: fetch a new one next time
        }

        return self::isUnregistered($response) ? 404 : $response['status'];
    }

    /** @param array{status: int, body: string} $response */
    public static function isUnregistered(array $response): bool
    {
        if ($response['status'] === 404) {
            return true;
        }
        $error = json_decode($response['body'], true);
        $details = \is_array($error) && \is_array($error['error'] ?? null) && \is_array($error['error']['details'] ?? null) ? $error['error']['details'] : [];
        foreach ($details as $detail) {
            if (\is_array($detail) && ($detail['errorCode'] ?? null) === 'UNREGISTERED') {
                return true;
            }
        }

        return false;
    }

    private function accessToken(): string
    {
        if ($this->accessToken !== null && time() < $this->accessTokenExpires - 60) {
            return $this->accessToken;
        }
        $now = time();
        $response = $this->http->post(
            self::TOKEN_URL,
            ['Content-Type' => 'application/x-www-form-urlencoded'],
            http_build_query(['grant_type' => 'urn:ietf:params:oauth:grant-type:jwt-bearer', 'assertion' => $this->jwt($now)]),
        );
        $body = json_decode($response['body'], true);
        if ($response['status'] !== 200 || !\is_array($body) || !\is_string($body['access_token'] ?? null)) {
            // The response body is not logged: it may echo parts of the request.
            throw new \RuntimeException("FCM OAuth token request failed (HTTP {$response['status']})");
        }
        $this->accessToken = $body['access_token'];
        $this->accessTokenExpires = $now + (\is_int($body['expires_in'] ?? null) ? $body['expires_in'] : self::TOKEN_LIFETIME);

        return $this->accessToken;
    }

    private function jwt(int $now): string
    {
        $segments = [
            self::b64(json_encode(['alg' => 'RS256', 'typ' => 'JWT'], JSON_THROW_ON_ERROR)),
            self::b64(json_encode([
                'iss' => $this->clientEmail,
                'scope' => self::SCOPE,
                'aud' => self::TOKEN_URL,
                'iat' => $now,
                'exp' => $now + self::TOKEN_LIFETIME,
            ], JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES)),
        ];
        $key = openssl_pkey_get_private($this->privateKey);
        if ($key === false || !openssl_sign(implode('.', $segments), $signature, $key, OPENSSL_ALGO_SHA256)) {
            throw new \RuntimeException('FCM service account key cannot sign');
        }
        $segments[] = self::b64($signature);

        return implode('.', $segments);
    }

    private static function b64(string $data): string
    {
        return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
    }
}
