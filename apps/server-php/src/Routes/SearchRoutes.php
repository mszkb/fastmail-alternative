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
use Fma\Mail\ProviderSearch;
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
    /** UIDs per folder that are mapped to local messages (newest first). */
    private const MAX_MAPPED_UIDS = 5000;
    private const CONNECT_TIMEOUT_SECONDS = 15.0;
    /** Overall deadline of one search. */
    private const SEARCH_DEADLINE_SECONDS = 30.0;

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
        $folders = ProviderSearch::folders($pdo, $accountId, $folderId, isset($query['includeJunk']));
        if ($folderId !== null && $folders === []) {
            return Json::write($response, ['message' => 'Ordner nicht gefunden.'], 404);
        }

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
            $this->logger->warn('search failed', ['accountId' => $accountId, 'code' => ProviderSearch::UNREACHABLE[0], 'errName' => $e::class]);

            return Json::write($response, ['message' => ProviderSearch::UNREACHABLE[2], 'code' => ProviderSearch::UNREACHABLE[0]], ProviderSearch::UNREACHABLE[1]);
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
     * Text criteria: q, from, to, subject; dates: since, before; flags
     * (`1`/`true`): unread, attachment; scope: includeJunk (also search
     * Spam and Trash), folderId.
     *
     * @return array{q?: string, from?: string, to?: string, subject?: string, since?: string, before?: string, unread?: true, attachment?: true, includeJunk?: true, folderId?: string}|string
     */
    public static function parseQuery(array $input): array|string
    {
        $query = [];
        foreach (['q', 'from', 'to', 'subject'] as $key) {
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
        foreach (['unread', 'attachment', 'includeJunk'] as $key) {
            $raw = $input[$key] ?? null;
            if ($raw === null || $raw === '' || $raw === '0' || $raw === 'false') {
                continue;
            }
            if ($raw !== '1' && $raw !== 'true') {
                return 'Ungültiger Filter.';
            }
            $query[$key] = true;
        }
        $folderId = $input['folderId'] ?? null;
        if ($folderId !== null && $folderId !== '') {
            if (!\is_string($folderId) || !Uuid::isValid(strtolower($folderId))) {
                return 'Ungültiger Ordner.';
            }
            $query['folderId'] = strtolower($folderId);
        }
        if (array_diff_key($query, ['folderId' => true, 'includeJunk' => true]) === []) {
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
     * @param array{q?: string, from?: string, to?: string, subject?: string, since?: string, before?: string, unread?: true, attachment?: true, includeJunk?: true, folderId?: string} $query
     *
     * @return array{folders: list<array{folderId: string, uidvalidity: string, uids: list<int>}>, foldersFailed: int}
     */
    private function searchProvider(AccountContext $context, array $folders, array $query): array
    {
        $deadline = microtime(true) + self::SEARCH_DEADLINE_SECONDS;
        $client = ProviderSearch::connect($this->policy ?? TransportPolicy::fromConfig($this->config), $context, self::CONNECT_TIMEOUT_SECONDS);
        try {
            return ProviderSearch::search($client, $folders, ImapActions::searchCriteria($query), $deadline);
        } finally {
            $client->logout();
        }
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
