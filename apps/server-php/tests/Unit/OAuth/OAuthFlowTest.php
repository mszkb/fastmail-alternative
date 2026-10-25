<?php

declare(strict_types=1);

namespace Fma\Tests\Unit\OAuth;

use Fma\Config;
use Fma\Mail\HostConfig;
use Fma\OAuth\OAuthException;
use Fma\OAuth\OAuthFlow;
use Fma\OAuth\Provider;
use Fma\Tests\Support\FakeTokenClient;
use PHPUnit\Framework\TestCase;

final class OAuthFlowTest extends TestCase
{
    private const REDIRECT = 'https://mail.example.org/api/oauth/callback';

    /** @param array<string, string> $extra */
    private static function config(array $extra = []): Config
    {
        return Config::fromArray($extra + [
            'MASTER_KEY' => base64_encode(str_repeat('k', 32)),
            'OAUTH_GOOGLE_CLIENT_ID' => 'google-client',
            'OAUTH_GOOGLE_CLIENT_SECRET' => 'google-secret',
            'OAUTH_MICROSOFT_CLIENT_ID' => 'ms-client',
            'OAUTH_MICROSOFT_CLIENT_SECRET' => 'ms-secret',
        ]);
    }

    private static function provider(string $id, ?Config $config = null): Provider
    {
        $provider = Provider::fromConfig($config ?? self::config(), $id);
        self::assertNotNull($provider);

        return $provider;
    }

    public function testProvidersNeedClientIdAndSecret(): void
    {
        $config = Config::fromArray(['OAUTH_GOOGLE_CLIENT_ID' => 'id', 'OAUTH_MICROSOFT_CLIENT_ID' => 'id', 'OAUTH_MICROSOFT_CLIENT_SECRET' => 'secret']);
        self::assertSame(['google' => false, 'microsoft' => true], Provider::availability($config));
        self::assertNull(Provider::fromConfig($config, 'yahoo'));
    }

    public function testMicrosoftTenantIsPartOfTheEndpointsAndValidated(): void
    {
        self::assertSame('https://login.microsoftonline.com/common/oauth2/v2.0/token', self::provider('microsoft')->tokenUrl);
        $tenant = self::provider('microsoft', self::config(['OAUTH_MICROSOFT_TENANT' => 'contoso.onmicrosoft.com']));
        self::assertSame('https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/authorize', $tenant->authorizeUrl);
        $bad = self::provider('microsoft', self::config(['OAUTH_MICROSOFT_TENANT' => '../evil']));
        self::assertStringContainsString('/common/', $bad->authorizeUrl);
    }

    public function testPublicUrlComesFromPublicUrlOrDomain(): void
    {
        self::assertSame('https://mail.example.org', OAuthFlow::publicUrl(Config::fromArray(['DOMAIN' => 'mail.example.org'])));
        self::assertNull(OAuthFlow::publicUrl(Config::fromArray(['DOMAIN' => ':80'])));
        self::assertNull(OAuthFlow::publicUrl(Config::fromArray([])));
        self::assertSame('https://proxy.example.org/mail', OAuthFlow::publicUrl(Config::fromArray(['DOMAIN' => ':80', 'PUBLIC_URL' => 'https://proxy.example.org/mail/'])));
        self::assertNull(OAuthFlow::publicUrl(Config::fromArray(['PUBLIC_URL' => 'javascript:alert(1)'])));
        self::assertSame(self::REDIRECT, (new OAuthFlow(Config::fromArray(['DOMAIN' => 'mail.example.org'])))->redirectUri());
    }

    public function testAuthorizationUrlUsesPkceS256AndProviderParameters(): void
    {
        $flow = new OAuthFlow(self::config(), new FakeTokenClient());
        $url = $flow->authorizationUrl(self::provider('google'), 'state-1', self::REDIRECT, 'me@gmail.com');
        self::assertStringStartsWith('https://accounts.google.com/o/oauth2/v2/auth?', $url);
        parse_str((string) parse_url($url, PHP_URL_QUERY), $query);
        self::assertSame('code', $query['response_type']);
        self::assertSame('google-client', $query['client_id']);
        self::assertSame(self::REDIRECT, $query['redirect_uri']);
        self::assertSame('https://mail.google.com/ openid email', $query['scope']);
        self::assertSame('state-1', $query['state']);
        self::assertSame('S256', $query['code_challenge_method']);
        self::assertSame(OAuthFlow::base64Url(hash('sha256', $flow->codeVerifier('state-1'), true)), $query['code_challenge']);
        self::assertSame('offline', $query['access_type']);
        self::assertSame('me@gmail.com', $query['login_hint']);
        self::assertArrayNotHasKey('client_secret', $query);
    }

    public function testCodeVerifierIsBoundToStateAndMasterKey(): void
    {
        $flow = new OAuthFlow(self::config());
        $verifier = $flow->codeVerifier('state-1');
        // RFC 7636: 43-128 characters of the unreserved set.
        self::assertMatchesRegularExpression('/^[A-Za-z0-9_-]{43,128}$/', $verifier);
        self::assertSame($verifier, $flow->codeVerifier('state-1'));
        self::assertNotSame($verifier, $flow->codeVerifier('state-2'));
        self::assertNotSame($verifier, (new OAuthFlow(self::config(['MASTER_KEY' => base64_encode(str_repeat('x', 32))])))->codeVerifier('state-1'));
    }

    public function testExchangeCodeSendsVerifierAndReadsTheAddressFromTheIdToken(): void
    {
        $client = (new FakeTokenClient())->respond(200, [
            'access_token' => 'at',
            'refresh_token' => 'rt',
            'expires_in' => 1800,
            'id_token' => FakeTokenClient::idToken(['email' => 'Me@Gmail.com']),
        ]);
        $flow = new OAuthFlow(self::config(), $client);
        $before = time();
        $tokens = $flow->exchangeCode(self::provider('google'), 'the-code', 'state-1', self::REDIRECT);
        self::assertSame('at', $tokens->accessToken);
        self::assertSame('rt', $tokens->refreshToken);
        self::assertSame('me@gmail.com', $tokens->email);
        self::assertGreaterThanOrEqual($before + 1800, $tokens->expiresAt);
        self::assertSame('https://oauth2.googleapis.com/token', $client->requests[0]['url']);
        self::assertSame([
            'grant_type' => 'authorization_code',
            'code' => 'the-code',
            'redirect_uri' => self::REDIRECT,
            'code_verifier' => $flow->codeVerifier('state-1'),
            'client_id' => 'google-client',
            'client_secret' => 'google-secret',
        ], $client->requests[0]['form']);
    }

    public function testExchangeCodeNeedsRefreshTokenAndAddress(): void
    {
        $idToken = FakeTokenClient::idToken(['email' => 'me@gmail.com']);
        $client = (new FakeTokenClient())
            ->respond(200, ['access_token' => 'at', 'id_token' => $idToken])
            ->respond(200, ['access_token' => 'at', 'refresh_token' => 'rt']);
        $flow = new OAuthFlow(self::config(), $client);
        foreach (['no_refresh_token', 'no_email'] as $expected) {
            try {
                $flow->exchangeCode(self::provider('google'), 'code', 'state', self::REDIRECT);
                self::fail("expected {$expected}");
            } catch (OAuthException $e) {
                self::assertSame($expected, $e->errorCode);
            }
        }
    }

    public function testRefreshErrorsMapToCodes(): void
    {
        $client = (new FakeTokenClient())
            ->respond(400, ['error' => 'invalid_grant', 'error_description' => 'Token has been expired or revoked.'])
            ->respond(500, ['error' => 'server_error'])
            ->respond(401, ['error' => 'invalid_client'])
            ->respond(200, ['token_type' => 'Bearer']);
        $client->responses[] = 'network';
        $flow = new OAuthFlow(self::config(), $client);
        $codes = [];
        for ($i = 0; $i < 5; ++$i) {
            try {
                $flow->refresh(self::provider('microsoft'), 'rt');
            } catch (OAuthException $e) {
                $codes[] = [$e->errorCode, $e->needsNewLogin()];
            }
        }
        self::assertSame([['invalid_grant', true], ['provider', false], ['invalid_client', false], ['provider', false], ['network', false]], $codes);
        self::assertSame(['grant_type' => 'refresh_token', 'refresh_token' => 'rt', 'client_id' => 'ms-client', 'client_secret' => 'ms-secret'], $client->requests[0]['form']);
    }

    public function testRefreshKeepsMissingRefreshTokenEmpty(): void
    {
        $tokens = (new OAuthFlow(self::config(), (new FakeTokenClient())->respond(200, ['access_token' => 'new', 'expires_in' => 'x'])))
            ->refresh(self::provider('google'), 'rt');
        self::assertSame('new', $tokens->accessToken);
        self::assertNull($tokens->refreshToken);
        self::assertGreaterThan(time() + 3000, $tokens->expiresAt);
    }

    public function testEmailFromIdToken(): void
    {
        self::assertSame('a@b.de', OAuthFlow::emailFromIdToken(FakeTokenClient::idToken(['email' => 'A@B.de', 'preferred_username' => 'x@y.de'])));
        // Microsoft: personal accounts may carry the address only in preferred_username.
        self::assertSame('me@outlook.com', OAuthFlow::emailFromIdToken(FakeTokenClient::idToken(['preferred_username' => 'Me@Outlook.com'])));
        self::assertNull(OAuthFlow::emailFromIdToken(FakeTokenClient::idToken(['preferred_username' => '+491701234567'])));
        self::assertNull(OAuthFlow::emailFromIdToken('not-a-jwt'));
        self::assertNull(OAuthFlow::emailFromIdToken('a.!!!.c'));
    }

    public function testXoauth2InitialResponse(): void
    {
        $config = new HostConfig('imap.gmail.com', 993, true, 'me@gmail.com', '', 'ya29.token');
        self::assertSame("user=me@gmail.com\x01auth=Bearer ya29.token\x01\x01", base64_decode($config->xoauth2(), true));
    }
}
