<?php

declare(strict_types=1);

namespace Fma\Routes;

use Fma\Auth\Session;
use Fma\Config;
use Fma\Db\Database;
use Fma\Db\Uuid;
use Fma\Http\Json;
use Fma\Http\Middleware\RequireAuth;
use Fma\Log\Logger;
use Fma\Mail\AccountContext;
use Fma\Mail\ImapActions;
use Fma\Mail\ImapClient;
use Fma\Mail\MailException;
use Fma\Mail\TransportPolicy;
use Fma\Security\RateLimiter;
use Fma\Security\RateLimitRule;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\App;

/**
 * GET /api/accounts/{id}/search (roadmap 5.1, ADR-0006): IMAP SEARCH at the provider, matching UIDs mapped back to
 * locally synced messages. No search index; nothing of the query or the
 * results is persisted.
 *
 * - One short-lived provider connection per search, guarded by the
 *   transport policy (SSRF, ports, STARTTLS) and an overall deadline.
 *   Accounts with an auth error or disabled are not contacted (409).
 * - Folders: the given one, or INBOX and the other selectable folders
 *   except Junk/Trash (at most MAX_FOLDERS, INBOX and special-use first).
 * - Mapping: UIDs are looked up in message_location with the folder's
 *   current UIDVALIDITY; matches without a local copy are only counted
 *   (`notSynced`).
 * - Privacy: the query is never logged (the request log has no query
 *   string) nor stored; failures log the error code only.
 * - Rate limit: RATE_LIMIT provider searches per account and minute in the
 *   rate_limit table (bucket `search`, keyed by account id). There is no
 *   in-process result cache (PHP keeps no state between
 *   requests), so every search counts.
 */
final class SearchRoutes
{
    public const RATE_LIMIT = 10;
    public const MAX_TERM_LENGTH = 200;
    public const MAX_RESULTS = 100;
    private const MAX_FOLDERS = 20;
    /** UIDs per folder that are mapped to local messages (newest first). */
    private const MAX_MAPPED_UIDS = 5000;
    private const CONNECT_TIMEOUT_SECONDS = 15.0;
    /** Overall deadline of one search. */
    private const SEARCH_DEADLINE_SECONDS = 30.0;
    /** Folder order of the default scope (lower first). */
    private const FOLDER_RANK = ['inbox' => 0, 'sent' => 1, 'archive' => 2, 'drafts' => 3];

    private const UNREACHABLE = ['UNREACHABLE', 502, 'Der Mailanbieter ist nicht erreichbar.'];
    private const TIMEOUT = ['TIMEOUT', 504, 'Die Suche beim Anbieter dauert zu lange.'];

    private readonly RateLimiter $rateLimiter;

    public function __construct(
        private readonly Database $db,
        private readonly Config $config,
        private readonly Logger $logger,
        private readonly ?TransportPolicy $policy = null,
    ) {
        $this->rateLimiter = new RateLimiter($db, [new RateLimitRule('search', self::RATE_LIMIT)]);
    }

    /** @param App<\Psr\Container\ContainerInterface|null> $app */
    public function register(App $app, RequireAuth $requireAuth): void
    {
        $app->get('/api/accounts/{id}/search', $this->search(...))->add($requireAuth);
    }

    /** @param array<string, string> $args */
    private function search(Request $request, Response $response, array $args): Response
    {
        $accountId = strtolower($args['id'] ?? '');
        $pdo = $this->db->pdo();
        /** @var array{wrapped_dek: string, status: string}|false $account */
        $account = Uuid::isValid($accountId)
            ? Database::run($pdo, 'SELECT wrapped_dek, status FROM mail_account WHERE id = ? AND user_id = ?', [$accountId, self::session($request)->userId])->fetch()
            : false;
        if ($account === false) {
            return Json::write($response, ['message' => 'Konto nicht gefunden.'], 404);
        }
        $query = self::parseQuery($request->getQueryParams());
        if (\is_string($query)) {
            return Json::write($response, ['message' => $query], 400);
        }

        $folderId = $query['folderId'] ?? null;
        /** @var list<array{id: string, path: string, special_use: ?string}> $folders */
        $folders = $folderId !== null
            ? Database::run($pdo, 'SELECT id, path, special_use FROM folder WHERE account_id = ? AND id = ? AND selectable', [$accountId, $folderId])->fetchAll()
            : Database::run(
                $pdo,
                "SELECT id, path, special_use FROM folder
                 WHERE account_id = ? AND selectable AND COALESCE(special_use, '') NOT IN ('junk', 'trash')",
                [$accountId],
            )->fetchAll();
        if ($folderId !== null && $folders === []) {
            return Json::write($response, ['message' => 'Ordner nicht gefunden.'], 404);
        }
        $rank = static fn(array $f): int => strtoupper($f['path']) === 'INBOX' ? -1 : (self::FOLDER_RANK[$f['special_use'] ?? ''] ?? 10);
        usort($folders, static fn(array $a, array $b): int => $rank($a) <=> $rank($b) ?: strcmp($a['path'], $b['path']));
        $folders = \array_slice($folders, 0, self::MAX_FOLDERS);

        if ($account['status'] === 'auth_error' || $account['status'] === 'disabled') {
            return Json::write($response, ['message' => 'Die Suche ist nicht möglich: Das Konto hat einen Anmeldefehler.'], 409);
        }
        if ($this->rateLimiter->hit('GET', 'search', $accountId) > 0) {
            return Json::write($response, ['message' => 'Zu viele Suchanfragen. Bitte in einer Minute erneut versuchen.'], 429);
        }

        try {
            $context = AccountContext::load($pdo, $accountId, $this->config->get('MASTER_KEY'));
            $provider = $this->searchProvider($context, $folders, $query);
        } catch (SearchFailure $e) {
            // Code only: provider responses may echo the query.
            $this->logger->warn('search failed', ['accountId' => $accountId, 'code' => $e->errorCode]);

            return Json::write($response, ['message' => $e->getMessage(), 'code' => $e->errorCode], $e->status);
        } catch (\Throwable $e) {
            $this->logger->warn('search failed', ['accountId' => $accountId, 'code' => self::UNREACHABLE[0], 'errName' => $e::class]);

            return Json::write($response, ['message' => self::UNREACHABLE[2], 'code' => self::UNREACHABLE[0]], self::UNREACHABLE[1]);
        }

        return Json::write($response, $this->mapResults($context, $provider))->withHeader('Cache-Control', 'no-store');
    }

    /**
     * Validates and normalizes raw query parameters like parseSearchQuery in
     * packages/shared/src/search.ts (trimmed, control characters replaced,
     * empty values dropped). Returns a German error message when invalid or
     * when no criterion is given.
     *
     * @param array<mixed> $input
     *
     * @return array{q?: string, from?: string, subject?: string, since?: string, before?: string, folderId?: string}|string
     */
    public static function parseQuery(array $input): array|string
    {
        $query = [];
        foreach (['q', 'from', 'subject'] as $key) {
            if (!\array_key_exists($key, $input)) {
                continue;
            }
            $raw = $input[$key];
            if (!\is_string($raw) || !mb_check_encoding($raw, 'UTF-8')) {
                return 'Ungültiger Suchbegriff.';
            }
            $value = trim((string) preg_replace('/[\x00-\x1f\x7f]+/', ' ', $raw));
            // JS string length counts UTF-16 code units.
            if (\strlen((string) mb_convert_encoding($value, 'UTF-16LE', 'UTF-8')) / 2 > self::MAX_TERM_LENGTH) {
                return 'Der Suchbegriff ist zu lang.';
            }
            if ($value !== '') {
                $query[$key] = $value;
            }
        }
        foreach (['since', 'before'] as $key) {
            $raw = $input[$key] ?? null;
            if ($raw === null || $raw === '') {
                continue;
            }
            if (!\is_string($raw) || !self::validDate($raw)) {
                return 'Ungültiges Datum.';
            }
            $query[$key] = $raw;
        }
        if (isset($query['since'], $query['before']) && $query['since'] >= $query['before']) {
            return 'Der Zeitraum ist leer.';
        }
        $folderId = $input['folderId'] ?? null;
        if ($folderId !== null && $folderId !== '') {
            if (!\is_string($folderId) || !Uuid::isValid(strtolower($folderId))) {
                return 'Ungültiger Ordner.';
            }
            $query['folderId'] = strtolower($folderId);
        }
        if (!isset($query['q']) && !isset($query['from']) && !isset($query['subject']) && !isset($query['since']) && !isset($query['before'])) {
            return 'Bitte einen Suchbegriff oder Zeitraum angeben.';
        }

        return $query;
    }

    private static function validDate(string $value): bool
    {
        if (preg_match('/^\d{4}-\d{2}-\d{2}$/', $value) !== 1) {
            return false;
        }
        $date = \DateTimeImmutable::createFromFormat('!Y-m-d', $value, new \DateTimeZone('UTC'));

        return $date !== false && $date->format('Y-m-d') === $value;
    }

    /**
     * @param list<array{id: string, path: string, special_use: ?string}> $folders
     * @param array{q?: string, from?: string, subject?: string, since?: string, before?: string, folderId?: string} $query
     *
     * @return array{folders: list<array{folderId: string, uidvalidity: string, uids: list<int>}>, foldersFailed: int}
     */
    private function searchProvider(AccountContext $context, array $folders, array $query): array
    {
        $deadline = microtime(true) + self::SEARCH_DEADLINE_SECONDS;
        try {
            $client = ImapClient::connect($this->policy ?? TransportPolicy::fromConfig($this->config), $context->imap, self::CONNECT_TIMEOUT_SECONDS);
        } catch (MailException $e) {
            throw match ($e->errorCode) {
                'PRIVATE_HOST_BLOCKED' => new SearchFailure('BLOCKED_HOST', 502, 'Interner IMAP-Host ist blockiert (SSRF-Schutz).'),
                'PORT_NOT_ALLOWED' => new SearchFailure('BLOCKED_PORT', 502, 'Dieser IMAP-Port ist nicht erlaubt.'),
                'TLS_REQUIRED' => new SearchFailure('TLS_REQUIRED', 502, 'Der Mailserver bietet keine verschlüsselte Verbindung (STARTTLS) an.'),
                'AUTH_FAILED' => new SearchFailure('AUTH_FAILED', 502, 'Der Anbieter hat die Zugangsdaten abgelehnt.'),
                default => new SearchFailure(...self::UNREACHABLE),
            };
        }
        $criteria = ImapActions::searchCriteria($query);
        $actions = new ImapActions($client);
        $result = ['folders' => [], 'foldersFailed' => 0];
        try {
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
                    // e.g. folder removed at the provider: the other folders still count.
                    ++$result['foldersFailed'];
                    continue;
                }
                $result['folders'][] = ['folderId' => $folder['id'], 'uidvalidity' => $selected['uidValidity'] ?? '', 'uids' => $uids];
            }
            if (microtime(true) >= $deadline) {
                throw new SearchFailure(...self::TIMEOUT);
            }
        } finally {
            $client->logout();
        }

        return $result;
    }

    /**
     * Maps the provider's UIDs to local messages (current UIDVALIDITY only).
     *
     * @param array{folders: list<array{folderId: string, uidvalidity: string, uids: list<int>}>, foldersFailed: int} $provider
     *
     * @return array<string, mixed>
     */
    private function mapResults(AccountContext $context, array $provider): array
    {
        $pdo = $this->db->pdo();
        $lists = new MessageRoutes($this->db, $this->config, $this->logger);
        $seen = [];
        $results = [];
        $providerMatches = 0;
        $localMatches = 0;
        $mappedTotal = 0;
        $truncated = false;
        foreach ($provider['folders'] as $hits) {
            $providerMatches += \count($hits['uids']);
            $mapped = \array_slice($hits['uids'], 0, self::MAX_MAPPED_UIDS);
            $mappedTotal += \count($mapped);
            if (\count($mapped) < \count($hits['uids'])) {
                $truncated = true;
            }
            if ($mapped === []) {
                continue;
            }
            $in = implode(', ', array_fill(0, \count($mapped), '?'));
            /** @var list<array<string, mixed>> $rows */
            $rows = Database::run(
                $pdo,
                'SELECT ' . MessageRoutes::LIST_COLUMNS . ", ml.uid
                 FROM message_location ml JOIN message m ON m.id = ml.message_id
                 WHERE ml.folder_id = ? AND ml.uidvalidity = ? AND ml.uid IN ({$in})",
                [$hits['folderId'], $hits['uidvalidity'] !== '' ? $hits['uidvalidity'] : '-1', ...$mapped],
            )->fetchAll();
            $localMatches += \count($rows);
            foreach ($rows as $row) {
                // The same message in several folders (copies, Gmail labels): once.
                $id = (string) $row['id'];
                if (isset($seen[$id])) {
                    continue;
                }
                $seen[$id] = true;
                $results[] = $lists->toListItem($context->dek, $row) + ['folderId' => $hits['folderId']];
            }
        }
        usort($results, static fn(array $a, array $b): int => strcmp((string) $b['date'], (string) $a['date']) ?: strcmp((string) $a['id'], (string) $b['id']));
        if (\count($results) > self::MAX_RESULTS) {
            $truncated = true;
        }

        return [
            'messages' => \array_slice($results, 0, self::MAX_RESULTS),
            'providerMatches' => $providerMatches,
            'notSynced' => max(0, $mappedTotal - $localMatches),
            'truncated' => $truncated,
            'foldersSearched' => \count($provider['folders']),
            'foldersFailed' => $provider['foldersFailed'],
        ];
    }

    private static function session(Request $request): Session
    {
        $session = $request->getAttribute('auth');
        if (!$session instanceof Session) {
            throw new \LogicException('route without RequireAuth');
        }

        return $session;
    }
}
