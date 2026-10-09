<?php

declare(strict_types=1);

namespace Fma\Routes;

use Fma\Auth\Session;
use Fma\Config;
use Fma\Crypto\Envelope;
use Fma\Db\Database;
use Fma\Db\Uuid;
use Fma\Http\Json;
use Fma\Http\Middleware\RequireAuth;
use Fma\Log\Logger;
use Fma\Mail\AccountContext;
use Fma\Mail\ImapActions;
use Fma\Mail\ImapClient;
use Fma\Mail\ProviderSearch;
use Fma\Mail\TransportPolicy;
use Fma\Security\RateLimiter;
use Fma\Security\RateLimitRule;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\App;

/**
 * GET /api/search (#121, ADR-0006 addendum): IMAP SEARCH across accounts,
 * merged by date and paged with a cursor.
 *
 * - Fan-out: the accounts are searched one after the other (PHP has no
 *   cheap parallelism, shared hosting included), each with its own
 *   deadline inside an overall one. An account that fails, times out, has
 *   an auth error or hit its rate limit gets that status in `accounts`;
 *   the others still deliver (principle 7).
 * - Result: per searched folder the matching UIDs (highest first, at most
 *   MAX_UIDS_PER_FOLDER) are kept in `search_result` for RESULT_TTL
 *   seconds - ids and UIDs only, never the terms. Later pages read them
 *   instead of searching again; after expiry the cursor searches again
 *   transparently (positions are UIDs, so the page continues where it
 *   was).
 * - Merge: every folder is a stream ordered by UID; the page takes the
 *   stream head with the newest date until `limit` (k-way merge). UIDs
 *   follow arrival, so the merged list is ordered by date across folders
 *   and accounts, and each page continues exactly after the last one (no
 *   duplicates or gaps).
 * - Hits with a local copy come from the database; hits without one get
 *   their list headers by UID FETCH for the current page only (not
 *   stored) and carry `id: null, synced: false`.
 * - Cursor: opaque, HMAC-signed with a key derived from MASTER_KEY; it
 *   holds the result id, a keyed hash of the query (a cursor only fits its
 *   own query) and the UID position per folder.
 * - Privacy as in SearchRoutes: the query is never logged nor stored.
 */
final class GlobalSearchRoutes
{
    public const DEFAULT_LIMIT = 50;
    public const MAX_LIMIT = 100;
    public const MAX_ACCOUNTS = 50;
    public const MAX_UIDS_PER_FOLDER = 10000;
    /** Seconds a result's UID lists are kept for later pages. */
    public const RESULT_TTL = 300;
    private const CONNECT_TIMEOUT_SECONDS = 8.0;
    /** Deadline of one account's search. */
    private const ACCOUNT_DEADLINE_SECONDS = 10.0;
    /** Deadline of the fan-out over all accounts (below PHP's usual 30 s). */
    private const SEARCH_DEADLINE_SECONDS = 25.0;
    /** Characters of a folder id that key its position in the cursor. */
    private const POSITION_KEY_LENGTH = 12;

    private readonly RateLimiter $rateLimiter;
    /** @var array<string, ImapClient> open connections of this request, by account */
    private array $clients = [];

    public function __construct(
        private readonly Database $db,
        private readonly Config $config,
        private readonly Logger $logger,
        private readonly ?TransportPolicy $policy = null,
    ) {
        // Same bucket as the search of one account: a global search counts once per account.
        $this->rateLimiter = new RateLimiter($db, [new RateLimitRule('search', SearchRoutes::RATE_LIMIT)]);
    }

    /** @param App<\Psr\Container\ContainerInterface|null> $app */
    public function register(App $app, RequireAuth $requireAuth): void
    {
        $app->get('/api/search', $this->search(...))->add($requireAuth);
    }

    private function search(Request $request, Response $response): Response
    {
        $userId = self::session($request)->userId;
        $params = $request->getQueryParams();
        $query = SearchRoutes::parseQuery($params);
        if (\is_string($query)) {
            return Json::write($response, ['message' => $query], 400);
        }
        $limit = self::parseLimit($params['limit'] ?? null);
        $requested = self::parseAccounts($params['accounts'] ?? null);
        if ($limit === null || $requested === null) {
            return Json::write($response, ['message' => 'Ungültige Parameter.'], 400);
        }
        $pdo = $this->db->pdo();
        $accounts = $this->accounts($userId, $requested);
        if ($requested !== [] && \count($accounts) !== \count($requested)) {
            return Json::write($response, ['message' => 'Konto nicht gefunden.'], 404);
        }
        $folderId = $query['folderId'] ?? null;
        if ($folderId !== null && \count($accounts) !== 1) {
            return Json::write($response, ['message' => 'Ein Ordner kann nur mit genau einem Konto gesucht werden.'], 400);
        }

        $hash = $this->queryHash($userId, $query, array_column($accounts, 'id'));
        $positions = [];
        $resultId = null;
        if (isset($params['cursor']) && $params['cursor'] !== '') {
            $cursor = \is_string($params['cursor']) ? $this->decodeCursor($params['cursor']) : null;
            if ($cursor === null || $cursor['h'] !== $hash) {
                return Json::write($response, ['message' => 'Ungültiger Cursor.'], 400);
            }
            $positions = $cursor['p'];
            $resultId = $cursor['r'];
        }

        try {
            $result = $resultId !== null ? $this->loadResult($userId, $resultId) : null;
            if ($result === null) {
                Database::run($pdo, 'DELETE FROM search_result WHERE expires_at < ?', [time()]);
                $result = $this->searchAccounts($accounts, $query);
                $resultId = Uuid::v4();
                Database::run(
                    $pdo,
                    'INSERT INTO search_result (id, user_id, expires_at, streams) VALUES (?, ?, ?, ?)',
                    [$resultId, $userId, time() + self::RESULT_TTL, json_encode($result, JSON_THROW_ON_ERROR)],
                );
            }
            $page = $this->page($result, $positions, $limit, $accounts);
        } finally {
            foreach ($this->clients as $client) {
                $client->logout();
            }
            $this->clients = [];
        }

        return Json::write($response, [
            'messages' => $page['messages'],
            'accounts' => $page['accounts'],
            'total' => array_sum(array_column($page['accounts'], 'matches')),
            'nextCursor' => $page['more'] ? $this->encodeCursor($resultId, $hash, $page['positions']) : null,
        ])->withHeader('Cache-Control', 'no-store');
    }

    /**
     * The user's accounts to search: the requested ones, or all except
     * disabled ones (in the order of the account rail).
     *
     * @param list<string> $requested
     *
     * @return list<array{id: string, status: string}>
     */
    private function accounts(string $userId, array $requested): array
    {
        $sql = 'SELECT id, status FROM mail_account WHERE user_id = ?';
        $params = [$userId];
        if ($requested !== []) {
            $sql .= ' AND id IN (' . implode(', ', array_fill(0, \count($requested), '?')) . ')';
            $params = [...$params, ...$requested];
        } else {
            $sql .= " AND status <> 'disabled'";
        }

        /** @var list<array{id: string, status: string}> */
        return Database::run($this->db->pdo(), $sql . ' ORDER BY sort_order, created_at, id', $params)->fetchAll();
    }

    /**
     * Searches each account at its provider, one after the other.
     *
     * @param list<array{id: string, status: string}> $accounts
     * @param array<string, mixed> $query parsed (SearchRoutes::parseQuery)
     *
     * @return array{accounts: list<array{accountId: string, status: string, code?: string, matches: int, foldersSearched: int, foldersFailed: int}>, streams: list<array{a: string, f: string, v: string, u: list<int>}>}
     */
    private function searchAccounts(array $accounts, array $query): array
    {
        $pdo = $this->db->pdo();
        $deadline = microtime(true) + self::SEARCH_DEADLINE_SECONDS;
        $folderId = isset($query['folderId']) && \is_string($query['folderId']) ? $query['folderId'] : null;
        /** @var array{q?: string, from?: string, to?: string, subject?: string, since?: string, before?: string, unread?: true, attachment?: true} $query */
        $criteria = ImapActions::searchCriteria($query);
        $result = ['accounts' => [], 'streams' => []];
        foreach ($accounts as $account) {
            $accountId = $account['id'];
            $entry = ['accountId' => $accountId, 'status' => 'ok', 'matches' => 0, 'foldersSearched' => 0, 'foldersFailed' => 0];
            $status = match (true) {
                $account['status'] === 'auth_error' => ['auth_error', 'AUTH_ERROR'],
                $account['status'] === 'disabled' => ['error', 'DISABLED'],
                microtime(true) >= $deadline => ['timeout', 'TIMEOUT'],
                default => null,
            };
            if ($status === null && $this->rateLimiter->hit('GET', 'search', $accountId) > 0) {
                $status = ['rate_limited', 'RATE_LIMITED'];
            }
            if ($status !== null) {
                $result['accounts'][] = ['accountId' => $accountId, 'status' => $status[0], 'code' => $status[1]] + $entry;
                continue;
            }
            $folders = ProviderSearch::folders($pdo, $accountId, $folderId);
            try {
                $accountDeadline = min($deadline, microtime(true) + self::ACCOUNT_DEADLINE_SECONDS);
                $context = AccountContext::load($pdo, $accountId, $this->config->get('MASTER_KEY'));
                $client = ProviderSearch::connect($this->policy(), $context, max(1.0, min(self::CONNECT_TIMEOUT_SECONDS, $accountDeadline - microtime(true))));
                $this->clients[$accountId] = $client;
                $found = ProviderSearch::search($client, $folders, $criteria, $accountDeadline);
            } catch (SearchFailure $e) {
                // Code only: provider responses may echo the query.
                $this->logger->warn('search failed', ['accountId' => $accountId, 'code' => $e->errorCode]);
                $this->drop($accountId);
                $result['accounts'][] = [
                    'accountId' => $accountId,
                    'status' => match ($e->errorCode) {
                        'TIMEOUT' => 'timeout',
                        'AUTH_FAILED' => 'auth_error',
                        default => 'error',
                    },
                    'code' => $e->errorCode,
                ] + $entry;
                continue;
            } catch (\Throwable $e) {
                $this->logger->warn('search failed', ['accountId' => $accountId, 'code' => ProviderSearch::UNREACHABLE[0], 'errName' => $e::class]);
                $this->drop($accountId);
                $result['accounts'][] = ['accountId' => $accountId, 'status' => 'error', 'code' => ProviderSearch::UNREACHABLE[0]] + $entry;
                continue;
            }
            foreach ($found['folders'] as $hits) {
                $entry['matches'] += \count($hits['uids']);
                $result['streams'][] = [
                    'a' => $accountId,
                    'f' => $hits['folderId'],
                    'v' => $hits['uidvalidity'],
                    'u' => \array_slice($hits['uids'], 0, self::MAX_UIDS_PER_FOLDER),
                ];
            }
            $entry['foldersSearched'] = \count($found['folders']);
            $entry['foldersFailed'] = $found['foldersFailed'];
            $result['accounts'][] = $entry;
        }

        return $result;
    }

    /**
     * One page of the merged result after the given positions.
     *
     * @param array{accounts: list<array{accountId: string, status: string, code?: string, matches: int, foldersSearched: int, foldersFailed: int}>, streams: list<array{a: string, f: string, v: string, u: list<int>}>} $result
     * @param array<string, int> $positions folder id prefix => last UID shown
     * @param list<array{id: string, status: string}> $accounts
     *
     * @return array{messages: list<array<string, mixed>>, accounts: list<array<string, mixed>>, positions: array<string, int>, more: bool}
     */
    private function page(array $result, array $positions, int $limit, array $accounts): array
    {
        $pdo = $this->db->pdo();
        $statuses = [];
        foreach ($result['accounts'] as $entry) {
            $statuses[$entry['accountId']] = $entry;
        }
        $wanted = array_flip(array_column($accounts, 'id'));
        $lists = new MessageRoutes($this->db, $this->config, $this->logger);
        $deks = [];

        // Per stream: the window of the next `limit` UIDs after its position.
        /** @var array<int, array{a: string, f: string, v: string, u: list<int>}> $streams */
        $streams = [];
        /** @var array<int, list<int>> $windows */
        $windows = [];
        foreach ($result['streams'] as $index => $stream) {
            if (!isset($wanted[$stream['a']])) {
                continue;
            }
            $window = self::window($stream['u'], $positions[self::positionKey($stream)] ?? PHP_INT_MAX, $limit);
            if ($window !== []) {
                $streams[$index] = $stream;
                $windows[$index] = $window;
            }
        }

        // List items: local copies from the database (one query per folder) ...
        /** @var array<int, array<int, array<string, mixed>>> $items */
        $items = [];
        foreach ($windows as $index => $window) {
            $stream = $streams[$index];
            $items[$index] = [];
            $in = implode(', ', array_fill(0, \count($window), '?'));
            /** @var list<array<string, mixed>> $rows */
            $rows = Database::run(
                $pdo,
                'SELECT ' . MessageRoutes::LIST_COLUMNS . ", ml.uid
                 FROM message_location ml JOIN message m ON m.id = ml.message_id
                 WHERE ml.folder_id = ? AND ml.uidvalidity = ? AND ml.uid IN ({$in})",
                [$stream['f'], $stream['v'] !== '' ? $stream['v'] : '-1', ...$window],
            )->fetchAll();
            foreach ($rows as $row) {
                $deks[$stream['a']] ??= $this->dek($stream['a']);
                $items[$index][(int) $row['uid']] = $lists->toListItem($deks[$stream['a']], $row) + ['synced' => true];
            }
        }
        // ... the others' headers from the provider (this page only, not stored).
        $failed = [];
        foreach ($windows as $index => $window) {
            $stream = $streams[$index];
            $missing = array_values(array_diff($window, array_keys($items[$index])));
            if ($missing === [] || isset($failed[$stream['a']])) {
                continue;
            }
            try {
                $path = Database::run($pdo, 'SELECT path FROM folder WHERE id = ?', [$stream['f']])->fetchColumn();
                $headers = \is_string($path) ? ProviderSearch::headers($this->client($stream['a']), $path, $stream['v'], $missing) : [];
            } catch (\Throwable $e) {
                $code = $e instanceof SearchFailure ? $e->errorCode : ProviderSearch::UNREACHABLE[0];
                $this->logger->warn('search headers failed', ['accountId' => $stream['a'], 'code' => $code]);
                $this->drop($stream['a']);
                $failed[$stream['a']] = $code;
                continue;
            }
            foreach ($headers as $uid => $header) {
                $items[$index][$uid] = ['id' => null, 'snippet' => '', 'threadId' => null, 'threadCount' => 1] + $header + ['synced' => false];
            }
        }

        // k-way merge over the shown hits (others: gone, UIDVALIDITY changed, provider down).
        /** @var array<int, list<int>> $queues */
        $queues = [];
        foreach ($windows as $index => $window) {
            $queues[$index] = array_values(array_filter($window, static fn(int $uid): bool => isset($items[$index][$uid])));
        }
        $messages = [];
        $seen = [];
        while (\count($messages) < $limit) {
            $best = null;
            $bestDate = '';
            foreach ($queues as $index => $queue) {
                if ($queue === []) {
                    continue;
                }
                $date = (string) $items[$index][$queue[0]]['date'];
                if ($best === null || strcmp($date, $bestDate) > 0) {
                    $best = $index;
                    $bestDate = $date;
                }
            }
            if ($best === null) {
                break;
            }
            $uid = (int) array_shift($queues[$best]);
            $stream = $streams[$best];
            $positions[self::positionKey($stream)] = $uid;
            $item = $items[$best][$uid];
            // The same message in several folders (copies, Gmail labels): once per page.
            if (\is_string($item['id'] ?? null)) {
                if (isset($seen[$item['id']])) {
                    continue;
                }
                $seen[$item['id']] = true;
            }
            $messages[] = $item + ['accountId' => $stream['a'], 'folderId' => $stream['f'], 'uid' => $uid];
        }

        $more = false;
        foreach ($streams as $index => $stream) {
            $key = self::positionKey($stream);
            // Every shown hit of the window taken: move past the ones that
            // could not be shown - unless the provider failed, then its
            // unsynced hits are retried on the next page.
            if ($queues[$index] === [] && !isset($failed[$stream['a']])) {
                $positions[$key] = min($positions[$key] ?? PHP_INT_MAX, $windows[$index][\count($windows[$index]) - 1]);
            }
            $more = $more || self::window($stream['u'], $positions[$key] ?? PHP_INT_MAX, 1) !== [];
        }
        // Nothing shown (e.g. only hits of an unreachable provider left): stop paging.
        $more = $more && $messages !== [];

        $out = [];
        foreach ($accounts as $account) {
            $entry = $statuses[$account['id']] ?? ['accountId' => $account['id'], 'status' => 'ok', 'matches' => 0, 'foldersSearched' => 0, 'foldersFailed' => 0];
            if (isset($failed[$account['id']]) && $entry['status'] === 'ok') {
                $entry['status'] = $failed[$account['id']] === 'TIMEOUT' ? 'timeout' : 'error';
                $entry['code'] = $failed[$account['id']];
            }
            $out[] = $entry;
        }

        return ['messages' => $messages, 'accounts' => $out, 'positions' => $positions, 'more' => $more];
    }

    /**
     * The next UIDs below `$after` (at most `$limit`).
     *
     * @param list<int> $uids highest first
     *
     * @return list<int>
     */
    private static function window(array $uids, int $after, int $limit): array
    {
        $window = [];
        foreach ($uids as $uid) {
            if ($uid < $after) {
                $window[] = $uid;
                if (\count($window) >= $limit) {
                    break;
                }
            }
        }

        return $window;
    }

    /** @param array{f: string} $stream */
    private static function positionKey(array $stream): string
    {
        return substr($stream['f'], 0, self::POSITION_KEY_LENGTH);
    }

    /**
     * Stored result of this user, null when unknown or expired.
     *
     * @return array{accounts: list<array{accountId: string, status: string, code?: string, matches: int, foldersSearched: int, foldersFailed: int}>, streams: list<array{a: string, f: string, v: string, u: list<int>}>}|null
     */
    private function loadResult(string $userId, string $resultId): ?array
    {
        $json = Database::run(
            $this->db->pdo(),
            'SELECT streams FROM search_result WHERE id = ? AND user_id = ? AND expires_at >= ?',
            [$resultId, $userId, time()],
        )->fetchColumn();
        if (!\is_string($json)) {
            return null;
        }
        /** @var array{accounts: list<array{accountId: string, status: string, code?: string, matches: int, foldersSearched: int, foldersFailed: int}>, streams: list<array{a: string, f: string, v: string, u: list<int>}>} */
        return json_decode($json, true, 16, JSON_THROW_ON_ERROR);
    }

    private function client(string $accountId): ImapClient
    {
        if (!isset($this->clients[$accountId])) {
            $context = AccountContext::load($this->db->pdo(), $accountId, $this->config->get('MASTER_KEY'));
            $this->clients[$accountId] = ProviderSearch::connect($this->policy(), $context, self::CONNECT_TIMEOUT_SECONDS);
        }

        return $this->clients[$accountId];
    }

    /** Closes and forgets an account's connection after an error. */
    private function drop(string $accountId): void
    {
        if (isset($this->clients[$accountId])) {
            $this->clients[$accountId]->disconnect();
            unset($this->clients[$accountId]);
        }
    }

    private function dek(string $accountId): string
    {
        $wrapped = Database::run($this->db->pdo(), 'SELECT wrapped_dek FROM mail_account WHERE id = ?', [$accountId])->fetchColumn();

        return Envelope::unwrapAccountKey($this->config->get('MASTER_KEY'), (string) $wrapped);
    }

    private function policy(): TransportPolicy
    {
        return $this->policy ?? TransportPolicy::fromConfig($this->config);
    }

    private function cursorKey(): string
    {
        return Envelope::deriveHmacKey(Envelope::loadMasterKey($this->config->get('MASTER_KEY')), 'search-cursor');
    }

    /**
     * Keyed hash of the query: a cursor fits only its own search, and the
     * terms never leave the request in readable form.
     *
     * @param array<string, mixed> $query
     * @param list<string> $accountIds
     */
    private function queryHash(string $userId, array $query, array $accountIds): string
    {
        ksort($query);

        return substr(Envelope::hmacValue($this->cursorKey(), json_encode([$userId, $query, $accountIds], JSON_THROW_ON_ERROR)), 0, 32);
    }

    /** @param array<string, int> $positions */
    private function encodeCursor(string $resultId, string $hash, array $positions): string
    {
        $payload = self::base64Url(json_encode(['r' => $resultId, 'h' => $hash, 'p' => (object) $positions], JSON_THROW_ON_ERROR));

        return $payload . '.' . self::base64Url(hash_hmac('sha256', $payload, $this->cursorKey(), true));
    }

    /** @return array{r: string, h: string, p: array<string, int>}|null */
    private function decodeCursor(string $cursor): ?array
    {
        $parts = explode('.', $cursor);
        if (\count($parts) !== 2 || \strlen($cursor) > 16384) {
            return null;
        }
        $mac = self::base64Url(hash_hmac('sha256', $parts[0], $this->cursorKey(), true));
        if (!hash_equals($mac, $parts[1])) {
            return null;
        }
        $data = json_decode((string) base64_decode(strtr($parts[0], '-_', '+/'), true), true);
        if (!\is_array($data) || !\is_string($data['r'] ?? null) || !Uuid::isValid($data['r']) || !\is_string($data['h'] ?? null) || !\is_array($data['p'] ?? null)) {
            return null;
        }
        $positions = [];
        foreach ($data['p'] as $key => $uid) {
            if (!\is_int($uid)) {
                return null;
            }
            $positions[(string) $key] = $uid;
        }

        return ['r' => $data['r'], 'h' => $data['h'], 'p' => $positions];
    }

    private static function base64Url(string $value): string
    {
        return rtrim(strtr(base64_encode($value), '+/', '-_'), '=');
    }

    private static function parseLimit(mixed $raw): ?int
    {
        if ($raw === null || $raw === '') {
            return self::DEFAULT_LIMIT;
        }
        if (!\is_string($raw) || preg_match('/^\d{1,3}$/', $raw) !== 1 || (int) $raw < 1 || (int) $raw > self::MAX_LIMIT) {
            return null;
        }

        return (int) $raw;
    }

    /** @return list<string>|null comma-separated account ids; [] = all */
    private static function parseAccounts(mixed $raw): ?array
    {
        if ($raw === null || $raw === '') {
            return [];
        }
        if (!\is_string($raw)) {
            return null;
        }
        $ids = array_values(array_unique(array_map(static fn(string $id): string => strtolower(trim($id)), explode(',', $raw))));
        if (\count($ids) > self::MAX_ACCOUNTS) {
            return null;
        }
        foreach ($ids as $id) {
            if (!Uuid::isValid($id)) {
                return null;
            }
        }

        return $ids;
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
