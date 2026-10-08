<?php

declare(strict_types=1);

namespace Fma\Mail;

use Fma\Crypto\Envelope;
use Fma\Db\Database;
use Fma\Jobs\AccountErrorException;

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

    public static function load(\PDO $pdo, string $accountId, #[\SensitiveParameter] string $masterKeyBase64): self
    {
        /** @var array{id: string, email_address: string, imap_host: string, imap_port: int|string, smtp_host: string, smtp_port: int|string, wrapped_dek: string, credential_enc: string}|false $row */
        $row = Database::run(
            $pdo,
            'SELECT id, email_address, imap_host, imap_port, smtp_host, smtp_port, wrapped_dek, credential_enc FROM mail_account WHERE id = ?',
            [$accountId],
        )->fetch();
        if ($row === false) {
            throw new \RuntimeException('account not found');
        }
        $dek = Envelope::unwrapAccountKey($masterKeyBase64, $row['wrapped_dek']);
        $credentials = json_decode(Envelope::decryptField($dek, $row['credential_enc'], Envelope::credentialAad($row['id'])), true);
        if (!\is_array($credentials) || !\is_string($credentials['imapUser'] ?? null) || !\is_string($credentials['imapPassword'] ?? null)) {
            throw new AccountErrorException('CREDENTIALS_REQUIRED');
        }
        $smtpUser = \is_string($credentials['smtpUser'] ?? null) && $credentials['smtpUser'] !== '' ? $credentials['smtpUser'] : $credentials['imapUser'];
        $smtpPassword = \is_string($credentials['smtpPassword'] ?? null) && $credentials['smtpPassword'] !== '' ? $credentials['smtpPassword'] : $credentials['imapPassword'];
        $imapPort = (int) $row['imap_port'];
        $smtpPort = (int) $row['smtp_port'];

        return new self(
            $row['id'],
            $row['email_address'],
            $dek,
            new HostConfig($row['imap_host'], $imapPort, TransportPolicy::isSecurePort($imapPort), $credentials['imapUser'], $credentials['imapPassword']),
            new HostConfig($row['smtp_host'], $smtpPort, TransportPolicy::isSecurePort($smtpPort), $smtpUser, $smtpPassword),
        );
    }
}
