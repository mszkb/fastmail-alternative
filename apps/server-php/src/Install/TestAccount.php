<?php

declare(strict_types=1);

namespace Fma\Install;

use Fma\Config;
use Fma\Db\Database;
use Fma\Jobs\JobQueue;
use Fma\Mail\ConnectionTester;
use Fma\Mail\HostConfig;
use Fma\Mail\TransportPolicy;
use Fma\Routes\AccountRoutes;

/**
 * Adds the developers' provider test account (LIVE_MAIL_*, the same values
 * as for tests/Live) to an instance on demand: `make test-account`. Never
 * part of an installation - without LIVE_MAIL_* nothing happens. Same path
 * as "Konto hinzufügen": connection test first, then AccountRoutes::insertAccount.
 */
final class TestAccount
{
    public const DISPLAY_NAME = 'Testkonto (live)';

    /**
     * @param array<string, string> $env LIVE_MAIL_USER, LIVE_MAIL_PASSWORD, LIVE_IMAP_HOST/PORT, LIVE_SMTP_HOST/PORT
     *
     * @return array{status: 'added'|'exists', accountId: string}
     *
     * @throws \RuntimeException with a message for the operator (never a credential)
     */
    public static function add(Database $db, Config $config, ConnectionTester $tester, JobQueue $jobs, array $env): array
    {
        $user = $env['LIVE_MAIL_USER'] ?? '';
        $password = $env['LIVE_MAIL_PASSWORD'] ?? '';
        $imapHost = $env['LIVE_IMAP_HOST'] ?? '';
        $smtpHost = $env['LIVE_SMTP_HOST'] ?? '';
        if ($user === '' || $password === '' || $imapHost === '' || $smtpHost === '') {
            throw new \RuntimeException('LIVE_MAIL_USER, LIVE_MAIL_PASSWORD, LIVE_IMAP_HOST and LIVE_SMTP_HOST are required (.env.live)');
        }
        $imapPort = (int) (($env['LIVE_IMAP_PORT'] ?? '') ?: 993);
        $smtpPort = (int) (($env['LIVE_SMTP_PORT'] ?? '') ?: 587);

        $pdo = $db->pdo();
        $userId = Database::run($pdo, 'SELECT id FROM `user` LIMIT 1')->fetchColumn();
        if (!\is_string($userId)) {
            throw new \RuntimeException('setup is not completed yet - create the user first');
        }
        $existing = Database::run($pdo, 'SELECT id FROM mail_account WHERE user_id = ? AND LOWER(email_address) = LOWER(?)', [$userId, $user])->fetchColumn();
        if (\is_string($existing)) {
            return ['status' => 'exists', 'accountId' => $existing];
        }

        $imap = new HostConfig($imapHost, $imapPort, TransportPolicy::isSecurePort($imapPort), $user, $password);
        $smtp = new HostConfig($smtpHost, $smtpPort, TransportPolicy::isSecurePort($smtpPort), $user, $password);
        $imapResult = $tester->testImap($imap);
        if (!$imapResult->ok) {
            throw new \RuntimeException("IMAP connection test failed: {$imapResult->code}");
        }
        $smtpResult = $tester->testSmtp($smtp);
        if (!$smtpResult->ok) {
            throw new \RuntimeException("SMTP connection test failed: {$smtpResult->code}");
        }

        $accountId = AccountRoutes::insertAccount(
            $pdo,
            $config,
            $jobs,
            $userId,
            self::DISPLAY_NAME,
            $user,
            $imap,
            $smtp,
            $imapResult->capabilities,
            null,
            static fn(string $dek, string $id): string => AccountRoutes::encryptCredentials($dek, $id, $imap, $smtp),
        );

        return ['status' => 'added', 'accountId' => $accountId];
    }
}
