<?php

declare(strict_types=1);

namespace Fma\OAuth;

use Fma\Config;

/**
 * OAuth2 mail providers (ADR-0011): Google and Microsoft. Every instance
 * registers its own app and configures it in the environment; a provider
 * without client id and secret is not offered. IMAP/SMTP hosts are fixed per
 * provider, logins use XOAUTH2.
 */
final class Provider
{
    public const IDS = ['google', 'microsoft'];

    /** @param list<string> $scopes */
    private function __construct(
        public readonly string $id,
        public readonly string $clientId,
        #[\SensitiveParameter]
        public readonly string $clientSecret,
        public readonly string $authorizeUrl,
        public readonly string $tokenUrl,
        public readonly array $scopes,
        /** @var array<string, string> extra parameters of the authorization request */
        public readonly array $authorizeParams,
        public readonly string $imapHost,
        public readonly int $imapPort,
        public readonly string $smtpHost,
        public readonly int $smtpPort,
    ) {}

    public static function fromConfig(Config $config, string $id): ?self
    {
        $prefix = 'OAUTH_' . strtoupper($id) . '_';
        $clientId = trim($config->get($prefix . 'CLIENT_ID'));
        $secret = trim($config->get($prefix . 'CLIENT_SECRET'));
        if ($clientId === '' || $secret === '') {
            return null;
        }

        return match ($id) {
            'google' => new self(
                'google',
                $clientId,
                $secret,
                'https://accounts.google.com/o/oauth2/v2/auth',
                'https://oauth2.googleapis.com/token',
                ['https://mail.google.com/', 'openid', 'email'],
                // A refresh token on every consent, not only the first one.
                ['access_type' => 'offline', 'prompt' => 'consent'],
                'imap.gmail.com',
                993,
                'smtp.gmail.com',
                465,
            ),
            'microsoft' => self::microsoft($clientId, $secret, $config->get('OAUTH_MICROSOFT_TENANT', 'common')),
            default => null,
        };
    }

    private static function microsoft(string $clientId, #[\SensitiveParameter] string $secret, string $tenant): self
    {
        $tenant = preg_match('/^[A-Za-z0-9.-]{1,64}$/', $tenant) === 1 ? $tenant : 'common';
        $base = "https://login.microsoftonline.com/{$tenant}/oauth2/v2.0";

        return new self(
            'microsoft',
            $clientId,
            $secret,
            "{$base}/authorize",
            "{$base}/token",
            ['https://outlook.office.com/IMAP.AccessAsUser.All', 'https://outlook.office.com/SMTP.Send', 'offline_access', 'openid', 'email'],
            ['prompt' => 'select_account'],
            'outlook.office365.com',
            993,
            'smtp.office365.com',
            587,
        );
    }

    /** @return array<string, bool> provider id => configured */
    public static function availability(Config $config): array
    {
        $result = [];
        foreach (self::IDS as $id) {
            $result[$id] = self::fromConfig($config, $id) !== null;
        }

        return $result;
    }
}
