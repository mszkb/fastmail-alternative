<?php

declare(strict_types=1);

namespace Fma\Mail;

use Fma\Db\Database;
use Fma\Routes\SearchFailure;

/**
 * IMAP SEARCH at the provider (ADR-0006), shared by the search of one
 * account (SearchRoutes) and the global search (GlobalSearchRoutes):
 * which folders are searched, connecting with stable error codes, the
 * search itself and the headers of matches without a local copy.
 *
 * Errors carry codes only: provider responses may echo the query.
 */
final class ProviderSearch
{
    public const MAX_FOLDERS = 20;
    /** Folder order of the default scope (lower first). */
    private const FOLDER_RANK = ['inbox' => 0, 'sent' => 1, 'archive' => 2, 'drafts' => 3];

    public const UNREACHABLE = ['UNREACHABLE', 502, 'Der Mailanbieter ist nicht erreichbar.'];
    public const TIMEOUT = ['TIMEOUT', 504, 'Die Suche beim Anbieter dauert zu lange.'];

    /**
     * The given folder, or INBOX and the other selectable folders except
     * Junk/Trash (at most MAX_FOLDERS, INBOX and special-use first).
     *
     * @return list<array{id: string, path: string, special_use: ?string}>
     */
    public static function folders(\PDO $pdo, string $accountId, ?string $folderId): array
    {
        /** @var list<array{id: string, path: string, special_use: ?string}> $folders */
        $folders = $folderId !== null
            ? Database::run($pdo, 'SELECT id, path, special_use FROM folder WHERE account_id = ? AND id = ? AND selectable', [$accountId, $folderId])->fetchAll()
            : Database::run(
                $pdo,
                "SELECT id, path, special_use FROM folder
                 WHERE account_id = ? AND selectable AND COALESCE(special_use, '') NOT IN ('junk', 'trash')",
                [$accountId],
            )->fetchAll();
        $rank = static fn(array $f): int => strtoupper($f['path']) === 'INBOX' ? -1 : (self::FOLDER_RANK[$f['special_use'] ?? ''] ?? 10);
        usort($folders, static fn(array $a, array $b): int => $rank($a) <=> $rank($b) ?: strcmp($a['path'], $b['path']));

        return \array_slice($folders, 0, self::MAX_FOLDERS);
    }

    /** Connects (transport policy applies); failures as SearchFailure. */
    public static function connect(TransportPolicy $policy, AccountContext $context, float $timeout): ImapClient
    {
        try {
            return ImapClient::connect($policy, $context->imap, $timeout);
        } catch (MailException $e) {
            throw match ($e->errorCode) {
                'PRIVATE_HOST_BLOCKED' => new SearchFailure('BLOCKED_HOST', 502, 'Interner IMAP-Host ist blockiert (SSRF-Schutz).'),
                'PORT_NOT_ALLOWED' => new SearchFailure('BLOCKED_PORT', 502, 'Dieser IMAP-Port ist nicht erlaubt.'),
                'TLS_REQUIRED' => new SearchFailure('TLS_REQUIRED', 502, 'Der Mailserver bietet keine verschlüsselte Verbindung (STARTTLS) an.'),
                'AUTH_FAILED' => new SearchFailure('AUTH_FAILED', 502, 'Der Anbieter hat die Zugangsdaten abgelehnt.'),
                'ETIMEDOUT' => new SearchFailure(...self::TIMEOUT),
                default => new SearchFailure(...self::UNREACHABLE),
            };
        }
    }

    /**
     * UID SEARCH in each folder until the deadline (unix time). A folder
     * the provider refuses (e.g. removed meanwhile) is counted in
     * `foldersFailed`; a lost connection or the deadline end the search.
     *
     * @param list<array{id: string, path: string, special_use: ?string}> $folders
     * @param array{parts: list<string>, utf8: bool} $criteria see ImapActions::searchCriteria()
     *
     * @return array{folders: list<array{folderId: string, uidvalidity: string, uids: list<int>}>, foldersFailed: int}
     */
    public static function search(ImapClient $client, array $folders, array $criteria, float $deadline): array
    {
        $actions = new ImapActions($client);
        $result = ['folders' => [], 'foldersFailed' => 0];
        foreach ($folders as $folder) {
            if (microtime(true) >= $deadline) {
                throw new SearchFailure(...self::TIMEOUT);
            }
            try {
                $selected = $actions->select($folder['path'], true);
                $uids = $actions->search($criteria['parts'], $criteria['utf8']);
            } catch (MailException $e) {
                if ($e->errorCode !== 'PROTOCOL') {
                    // Connection lost or timed out: no further folders.
                    throw $e->errorCode === 'ETIMEDOUT' ? new SearchFailure(...self::TIMEOUT) : new SearchFailure(...self::UNREACHABLE);
                }
                ++$result['foldersFailed'];
                continue;
            }
            $result['folders'][] = ['folderId' => $folder['id'], 'uidvalidity' => $selected['uidValidity'] ?? '', 'uids' => $uids];
        }
        if (microtime(true) >= $deadline) {
            throw new SearchFailure(...self::TIMEOUT);
        }

        return $result;
    }

    /**
     * List headers of matches without a local copy, for one page only (not
     * stored, ADR-0006 addendum). Empty when the folder's UIDVALIDITY
     * changed since the search: its UIDs no longer name the same messages.
     *
     * @param list<int> $uids
     *
     * @return array<int, array{subject: string, from: ?array{name: string, address: string}, date: string, flags: array{seen: bool, flagged: bool, answered: bool}, hasAttachments: bool}>
     */
    public static function headers(ImapClient $client, string $path, string $uidvalidity, array $uids): array
    {
        if ($uids === []) {
            return [];
        }
        $selected = (new ImapActions($client))->select($path, true);
        if (($selected['uidValidity'] ?? '') !== $uidvalidity) {
            return [];
        }
        $wanted = array_flip($uids);
        $result = [];
        foreach ($client->command('UID FETCH ' . ImapMailbox::uidSet($uids) . ' (UID FLAGS INTERNALDATE ENVELOPE BODYSTRUCTURE)') as $line) {
            $attrs = ImapMailbox::parseFetch($line);
            if ($attrs === null || !isset($attrs['UID']) || !isset($wanted[(int) $attrs['UID']])) {
                continue;
            }
            $envelope = ImapMailbox::envelope($attrs['ENVELOPE'] ?? null);
            $flags = array_map(
                static fn(mixed $f): string => strtolower(\is_string($f) ? $f : ''),
                \is_array($attrs['FLAGS'] ?? null) ? $attrs['FLAGS'] : [],
            );
            $structure = $attrs['BODYSTRUCTURE'] ?? null;
            $result[(int) $attrs['UID']] = [
                'subject' => $envelope['subject'],
                'from' => $envelope['from'][0] ?? null,
                // Like the sync: the Date header first, then the arrival time.
                'date' => self::isoDate($envelope['date']) ?? self::isoDate(\is_string($attrs['INTERNALDATE'] ?? null) ? $attrs['INTERNALDATE'] : null) ?? '1970-01-01T00:00:00.000Z',
                'flags' => ['seen' => \in_array('\seen', $flags, true), 'flagged' => \in_array('\flagged', $flags, true), 'answered' => \in_array('\answered', $flags, true)],
                'hasAttachments' => \is_array($structure) && isset($structure[0]) && \is_array($structure[0]),
            ];
        }

        return $result;
    }

    /** RFC 2822 / IMAP date as ISO-8601 UTC with milliseconds; null when unreadable. */
    public static function isoDate(?string $value): ?string
    {
        if ($value === null || trim($value) === '') {
            return null;
        }
        // Comments like "(CET)" confuse the parser.
        $value = trim((string) preg_replace('/\([^)]*\)/', '', $value));
        try {
            $date = new \DateTimeImmutable($value);
        } catch (\Exception) {
            return null;
        }

        return $date->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d\TH:i:s.v\Z');
    }
}
