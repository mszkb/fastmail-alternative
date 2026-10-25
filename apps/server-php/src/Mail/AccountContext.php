<?php

declare(strict_types=1);

namespace Fma\Mail;

use Fma\Config;
use Fma\Crypto\Envelope;
use Fma\Db\Database;
use Fma\Jobs\AccountErrorException;
use Fma\OAuth\AccountTokens;
use Fma\OAuth\Provider;
use Fma\OAuth\TokenClient;

/**
 * An account's DEK and decrypted IMAP/SMTP logins for a job. SMTP falls back to the IMAP login. Never
 * log or persist these values.
 */
final class AccountContext
{
    private function __construct(
        public readonly string $accountId,
        public readonly string $emailAddress,
        #[\SensitiveParameter]
        public readonly string $dek,
        public readonly HostConfig $imap,
        public readonly HostConfig $smtp,
    ) {}

    /**
     * @param TokenClient|null $tokens token endpoint client for OAuth refreshes (tests inject a fake)
     *
     * @throws AccountErrorException when the credentials are missing or an OAuth grant cannot be refreshed
     */
    public static function load(\PDO $pdo, string $accountId, Config $config, ?TokenClient $tokens = null): self
    {
        /** @var array{id: string, email_address: string, imap_host: string, imap_port: int|string, smtp_host: string, smtp_port: int|string, wrapped_dek: string, credential_enc: string, credential_kind: string, oauth_provider: ?string}|false $row */
        $row = Database::run(
            $pdo,
            'SELECT id, email_address, imap_host, imap_port, smtp_host, smtp_port, wrapped_dek, credential_enc, credential_kind, oauth_provider FROM mail_account WHERE id = ?',
            [$accountId],
        )->fetch();
        if ($row === false) {
            throw new \RuntimeException('account not found');
        }
        $dek = Envelope::unwrapAccountKey($config->get('MASTER_KEY'), $row['wrapped_dek']);
        $credentials = json_decode(Envelope::decryptField($dek, $row['credential_enc'], Envelope::credentialAad($row['id'])), true);
        if (!\is_array($credentials) || !\is_string($credentials['imapUser'] ?? null)) {
            throw new AccountErrorException('CREDENTIALS_REQUIRED');
        }
        $imapPort = (int) $row['imap_port'];
        $smtpPort = (int) $row['smtp_port'];
        $imapSecure = TransportPolicy::isSecurePort($imapPort);
        $smtpSecure = TransportPolicy::isSecurePort($smtpPort);

        if ($row['credential_kind'] === 'oauth2') {
            // Always the provider's own servers: the token must never reach a
            // host from the row (e.g. one an imported config file put there).
            $provider = Provider::fromConfig($config, (string) $row['oauth_provider']);
            if ($provider === null) {
                throw new AccountErrorException('OAUTH_NOT_CONFIGURED');
            }
            // XOAUTH2 with the same user and token for IMAP and SMTP.
            $token = AccountTokens::accessToken($pdo, $config, $tokens, $row['id'], $dek, $credentials);
            $user = $credentials['imapUser'];

            return new self(
                $row['id'],
                $row['email_address'],
                $dek,
                new HostConfig($provider->imapHost, $provider->imapPort, TransportPolicy::isSecurePort($provider->imapPort), $user, '', $token),
                new HostConfig($provider->smtpHost, $provider->smtpPort, TransportPolicy::isSecurePort($provider->smtpPort), $user, '', $token),
            );
        }

        if (!\is_string($credentials['imapPassword'] ?? null)) {
            throw new AccountErrorException('CREDENTIALS_REQUIRED');
        }
        $smtpUser = \is_string($credentials['smtpUser'] ?? null) && $credentials['smtpUser'] !== '' ? $credentials['smtpUser'] : $credentials['imapUser'];
        $smtpPassword = \is_string($credentials['smtpPassword'] ?? null) && $credentials['smtpPassword'] !== '' ? $credentials['smtpPassword'] : $credentials['imapPassword'];

        return new self(
            $row['id'],
            $row['email_address'],
            $dek,
            new HostConfig($row['imap_host'], $imapPort, $imapSecure, $credentials['imapUser'], $credentials['imapPassword']),
            new HostConfig($row['smtp_host'], $smtpPort, $smtpSecure, $smtpUser, $smtpPassword),
        );
    }
}
