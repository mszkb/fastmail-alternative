<?php

declare(strict_types=1);

namespace Fma\OAuth;

use Fma\Config;
use Fma\Crypto\Envelope;
use Fma\Db\Database;
use Fma\Jobs\AccountErrorException;

/**
 * Access token of an OAuth account (credential_kind 'oauth2'). Credentials
 * JSON: {imapUser, oauth: {provider, refreshToken, accessToken, expiresAt}},
 * encrypted like passwords (ADR-0011). An expired token is refreshed under a
 * row lock, so parallel jobs refresh once; a rotated refresh token is stored.
 * A revoked grant ends in OAUTH_EXPIRED (auth_error for this account only).
 */
final class AccountTokens
{
    /** Refresh this long before the access token expires. */
    private const MARGIN_SECONDS = 120;

    /**
     * @param array<string, mixed> $credentials decrypted credentials of the account
     *
     * @throws AccountErrorException
     */
    public static function accessToken(\PDO $pdo, Config $config, ?TokenClient $client, string $accountId, #[\SensitiveParameter] string $dek, #[\SensitiveParameter] array $credentials): string
    {
        $oauth = self::oauth($credentials);
        if ($oauth['expiresAt'] > time() + self::MARGIN_SECONDS) {
            return $oauth['accessToken'];
        }
        $provider = Provider::fromConfig($config, $oauth['provider']);
        if ($provider === null) {
            throw new AccountErrorException('OAUTH_NOT_CONFIGURED');
        }

        $pdo->beginTransaction();
        try {
            $encrypted = Database::run($pdo, 'SELECT credential_enc FROM mail_account WHERE id = ? FOR UPDATE', [$accountId])->fetchColumn();
            $current = \is_string($encrypted) ? json_decode(Envelope::decryptField($dek, $encrypted, Envelope::credentialAad($accountId)), true) : null;
            $oauth = self::oauth(\is_array($current) ? $current : $credentials);
            // Another job may have refreshed meanwhile.
            if ($oauth['expiresAt'] > time() + self::MARGIN_SECONDS) {
                $pdo->commit();

                return $oauth['accessToken'];
            }
            try {
                $tokens = (new OAuthFlow($config, $client ?? new HttpTokenClient()))->refresh($provider, $oauth['refreshToken']);
            } catch (OAuthException $e) {
                throw new AccountErrorException($e->needsNewLogin() ? 'OAUTH_EXPIRED' : 'TIMEOUT', $e);
            }
            $updated = \is_array($current) ? $current : $credentials;
            $updated['oauth'] = [
                'provider' => $oauth['provider'],
                'refreshToken' => $tokens->refreshToken ?? $oauth['refreshToken'],
                'accessToken' => $tokens->accessToken,
                'expiresAt' => $tokens->expiresAt,
            ];
            Database::run($pdo, 'UPDATE mail_account SET credential_enc = ? WHERE id = ?', [
                self::encrypt($dek, $accountId, $updated),
                $accountId,
            ]);
            $pdo->commit();

            return $tokens->accessToken;
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
    }

    /**
     * Credentials JSON of an OAuth account, encrypted for credential_enc.
     *
     * @return array<string, mixed>
     */
    public static function credentials(string $provider, string $email, TokenSet $tokens): array
    {
        return [
            'imapUser' => $email,
            'oauth' => [
                'provider' => $provider,
                'refreshToken' => $tokens->refreshToken,
                'accessToken' => $tokens->accessToken,
                'expiresAt' => $tokens->expiresAt,
            ],
        ];
    }

    /** @param array<string, mixed> $credentials */
    public static function encrypt(#[\SensitiveParameter] string $dek, string $accountId, #[\SensitiveParameter] array $credentials): string
    {
        return Envelope::encryptField($dek, json_encode($credentials, JSON_THROW_ON_ERROR), Envelope::credentialAad($accountId));
    }

    /**
     * @param array<string, mixed> $credentials
     *
     * @return array{provider: string, refreshToken: string, accessToken: string, expiresAt: int}
     */
    private static function oauth(#[\SensitiveParameter] array $credentials): array
    {
        $oauth = $credentials['oauth'] ?? null;
        if (!\is_array($oauth) || !\is_string($oauth['provider'] ?? null) || !\is_string($oauth['refreshToken'] ?? null)
            || !\is_string($oauth['accessToken'] ?? null) || !\is_int($oauth['expiresAt'] ?? null)) {
            throw new AccountErrorException('CREDENTIALS_REQUIRED');
        }

        return ['provider' => $oauth['provider'], 'refreshToken' => $oauth['refreshToken'], 'accessToken' => $oauth['accessToken'], 'expiresAt' => $oauth['expiresAt']];
    }
}
