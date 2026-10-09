<?php

declare(strict_types=1);

namespace Fma\OAuth;

use Fma\Config;

/**
 * Authorization code flow with PKCE (RFC 7636) and the token refresh.
 *
 * - The state is random; the PKCE verifier is derived from it with an HMAC
 *   under the master key, so nothing secret has to be stored between start
 *   and callback (OAuthStates keeps only a hash of the state).
 * - The e-mail address comes from the id_token of the token response. Its
 *   signature is not checked: the token comes straight from the provider's
 *   token endpoint over verified TLS (OpenID Connect Core 3.1.3.7).
 * - Errors become OAuthException codes; provider texts are never passed on.
 */
final class OAuthFlow
{
    public function __construct(
        private readonly Config $config,
        private readonly TokenClient $client = new HttpTokenClient(),
    ) {}

    /** Public base URL of the instance, from PUBLIC_URL or https://DOMAIN. */
    public static function publicUrl(Config $config): ?string
    {
        $url = rtrim(trim($config->get('PUBLIC_URL')), '/');
        if ($url !== '') {
            return preg_match('~^https?://[^/\s?#]+(?:/[^\s?#]*)?$~', $url) === 1 ? $url : null;
        }
        $domain = trim($config->get('DOMAIN', ':80'));
        if ($domain === '' || str_starts_with($domain, ':') || preg_match('/^[A-Za-z0-9.-]+$/', $domain) !== 1) {
            return null;
        }

        return "https://{$domain}";
    }

    public function redirectUri(): ?string
    {
        $base = self::publicUrl($this->config);

        return $base === null ? null : "{$base}/api/oauth/callback";
    }

    public function codeVerifier(string $state): string
    {
        $key = base64_decode($this->config->get('MASTER_KEY'), true);
        if ($key === false || $key === '') {
            throw new \RuntimeException('MASTER_KEY missing');
        }

        return self::base64Url(hash_hmac('sha256', "oauth-pkce|{$state}", $key, true));
    }

    public function authorizationUrl(Provider $provider, string $state, string $redirectUri, ?string $loginHint = null): string
    {
        $params = [
            'response_type' => 'code',
            'client_id' => $provider->clientId,
            'redirect_uri' => $redirectUri,
            'scope' => implode(' ', $provider->scopes),
            'state' => $state,
            'code_challenge' => self::base64Url(hash('sha256', $this->codeVerifier($state), true)),
            'code_challenge_method' => 'S256',
        ] + $provider->authorizeParams;
        if ($loginHint !== null && $loginHint !== '') {
            $params['login_hint'] = $loginHint;
        }

        return $provider->authorizeUrl . '?' . http_build_query($params, '', '&', PHP_QUERY_RFC3986);
    }

    public function exchangeCode(Provider $provider, #[\SensitiveParameter] string $code, string $state, string $redirectUri): TokenSet
    {
        $tokens = $this->request($provider, [
            'grant_type' => 'authorization_code',
            'code' => $code,
            'redirect_uri' => $redirectUri,
            'code_verifier' => $this->codeVerifier($state),
        ]);
        if ($tokens->refreshToken === null) {
            throw new OAuthException('no_refresh_token');
        }
        if ($tokens->email === null) {
            throw new OAuthException('no_email');
        }

        return $tokens;
    }

    /** New access token; providers may rotate the refresh token (then it is returned). */
    public function refresh(Provider $provider, #[\SensitiveParameter] string $refreshToken): TokenSet
    {
        return $this->request($provider, ['grant_type' => 'refresh_token', 'refresh_token' => $refreshToken]);
    }

    /** @param array<string, string> $grant */
    private function request(Provider $provider, #[\SensitiveParameter] array $grant): TokenSet
    {
        $result = $this->client->post($provider->tokenUrl, $grant + [
            'client_id' => $provider->clientId,
            'client_secret' => $provider->clientSecret,
        ]);
        $body = $result['body'];
        if ($result['status'] !== 200) {
            throw new OAuthException(($body['error'] ?? null) === 'invalid_grant' ? 'invalid_grant' : 'provider');
        }
        $access = $body['access_token'] ?? null;
        if (!\is_string($access) || $access === '') {
            throw new OAuthException('provider');
        }
        $expiresIn = $body['expires_in'] ?? 3600;
        $refresh = $body['refresh_token'] ?? null;
        $idToken = $body['id_token'] ?? null;

        return new TokenSet(
            $access,
            \is_string($refresh) && $refresh !== '' ? $refresh : null,
            time() + max(60, is_numeric($expiresIn) ? (int) $expiresIn : 3600),
            \is_string($idToken) ? self::emailFromIdToken($idToken) : null,
        );
    }

    /** E-mail claim of an id_token (Microsoft: preferred_username as fallback), lower-cased. */
    public static function emailFromIdToken(string $idToken): ?string
    {
        $parts = explode('.', $idToken);
        if (\count($parts) !== 3) {
            return null;
        }
        $payload = base64_decode(strtr($parts[1], '-_', '+/'), true);
        $claims = $payload === false ? null : json_decode($payload, true);
        if (!\is_array($claims)) {
            return null;
        }
        foreach (['email', 'preferred_username'] as $claim) {
            $value = $claims[$claim] ?? null;
            if (\is_string($value) && preg_match('/^[^\s@]+@[^\s@]+\.[^\s@]+$/', $value) === 1) {
                return mb_strtolower($value);
            }
        }

        return null;
    }

    public static function base64Url(string $bytes): string
    {
        return rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
    }
}
