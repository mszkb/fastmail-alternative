<?php

declare(strict_types=1);

namespace Fma\Routes;

use Fma\Auth\Session;
use Fma\Auth\Sessions;
use Fma\Config;
use Fma\Crypto\Envelope;
use Fma\Db\Database;
use Fma\Db\Uuid;
use Fma\Http\Json;
use Fma\Http\Middleware\RequireAuth;
use Fma\Log\Logger;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\App;

/**
 * Mail read API (roadmap 2.3, 2.5, 3.7): folder tree, paginated message lists, message
 * details, threads and the optional unified inbox.
 *
 * - Every query is scoped via mail_account.user_id; foreign or unknown ids
 *   answer 404 (no existence oracle).
 * - Human-readable fields are decrypted with the account DEK (unwrapped per
 *   request); decrypted values are never logged.
 * - Lists use keyset pagination over (sort date, location id), no OFFSET.
 * - Flags live in message_flag (one row per flag and location).
 */
final class MessageRoutes
{
    public const DEFAULT_LIMIT = 50;
    public const MAX_LIMIT = 100;
    /** Newest messages returned per thread. */
    private const MAX_THREAD_MESSAGES = 200;
    private const BAD_PARAMS = 'Ungültige Parameter (cursor/limit).';

    /** Folder order among siblings: INBOX, special-use folders, then by name. */
    private const SPECIAL_USE_RANK = ['inbox' => 0, 'drafts' => 1, 'sent' => 2, 'archive' => 3, 'junk' => 4, 'trash' => 5];

    /** Deterministic id the sync generates for messages without Message-ID. */
    private const FALLBACK_MESSAGE_ID_RE = '/^<[0-9a-f]{64}@fma\.local>$/';

    /** Sort date of a message: Date header, falling back to arrival/insert time. */
    public const SORT_AT = 'COALESCE(m.sent_at, m.received_at, m.created_at)';

    /**
     * List columns of a message location (alias `ml`) joined with its
     * message (alias `m`).
     */
    public const LIST_COLUMNS = "ml.id AS location_id, m.id, m.subject_enc, m.from_enc, m.snippet_enc, m.has_attachments,
        EXISTS (SELECT 1 FROM message_flag mf WHERE mf.location_id = ml.id AND LOWER(CONVERT(mf.flag USING utf8mb4)) = '\\\\seen') AS flag_seen,
        EXISTS (SELECT 1 FROM message_flag mf WHERE mf.location_id = ml.id AND LOWER(CONVERT(mf.flag USING utf8mb4)) = '\\\\flagged') AS flag_flagged,
        EXISTS (SELECT 1 FROM message_flag mf WHERE mf.location_id = ml.id AND LOWER(CONVERT(mf.flag USING utf8mb4)) = '\\\\answered') AS flag_answered,
        " . self::SORT_AT . ' AS sort_at,
        m.thread_id,
        CASE WHEN m.thread_id IS NULL THEN 1
             ELSE (SELECT COUNT(*) FROM message t WHERE t.thread_id = m.thread_id)
        END AS thread_count';

    /**
     * Message details incl. account DEK; callers add the WHERE clause
     * (always scoped by a.user_id). Flags: union over all locations.
     */
    private const DETAIL_SELECT = 'SELECT m.id, m.account_id, m.thread_id, a.wrapped_dek, m.subject_enc,
          m.from_enc, m.recipients_enc, m.message_id_header, m.`references`,
          ' . self::SORT_AT . " AS sort_at, m.has_attachments, mb.text_plain_enc,
          EXISTS (SELECT 1 FROM message_location ml JOIN message_flag mf ON mf.location_id = ml.id
                  WHERE ml.message_id = m.id AND LOWER(CONVERT(mf.flag USING utf8mb4)) = '\\\\seen') AS flag_seen,
          EXISTS (SELECT 1 FROM message_location ml JOIN message_flag mf ON mf.location_id = ml.id
                  WHERE ml.message_id = m.id AND LOWER(CONVERT(mf.flag USING utf8mb4)) = '\\\\flagged') AS flag_flagged,
          EXISTS (SELECT 1 FROM message_location ml JOIN message_flag mf ON mf.location_id = ml.id
                  WHERE ml.message_id = m.id AND LOWER(CONVERT(mf.flag USING utf8mb4)) = '\\\\answered') AS flag_answered,
          (SELECT GROUP_CONCAT(ml.folder_id) FROM message_location ml WHERE ml.message_id = m.id) AS folder_ids
        FROM message m
        JOIN mail_account a ON a.id = m.account_id
        LEFT JOIN message_body mb ON mb.message_id = m.id";

    public function __construct(
        private readonly Database $db,
        private readonly Config $config,
        private readonly Logger $logger,
    ) {}

    /** @param App<\Psr\Container\ContainerInterface|null> $app */
    public function register(App $app, RequireAuth $requireAuth): void
    {
        $app->get('/api/accounts/{id}/folders', $this->folders(...))->add($requireAuth);
        $app->get('/api/folders/{id}/messages', $this->messages(...))->add($requireAuth);
        $app->get('/api/messages/{id}', $this->message(...))->add($requireAuth);
        $app->get('/api/threads/{id}', $this->thread(...))->add($requireAuth);
        $app->get('/api/unified/inbox', $this->unifiedInbox(...))->add($requireAuth);
    }

    /** @param array<string, string> $args */
    private function folders(Request $request, Response $response, array $args): Response
    {
        $accountId = strtolower($args['id'] ?? '');
        $pdo = $this->db->pdo();
        if (!Uuid::isValid($accountId)
            || Database::run($pdo, 'SELECT 1 FROM mail_account WHERE id = ? AND user_id = ?', [$accountId, self::session($request)->userId])->fetchColumn() === false) {
            return Json::write($response, ['message' => 'Konto nicht gefunden.'], 404);
        }
        // Counts come from the synced locations, so they match what the list can show.
        /** @var list<array{id: string, path: string, delimiter: ?string, special_use: ?string, special_use_override: ?string, selectable: int|bool, unread_count: int|string, total: int|string}> $rows */
        $rows = Database::run(
            $pdo,
            'SELECT f.id, f.path, f.delimiter, f.special_use, f.special_use_override, f.selectable,
                    COUNT(ml.id) - COUNT(sf.location_id) AS unread_count,
                    COUNT(ml.id) AS total
             FROM folder f
             LEFT JOIN message_location ml ON ml.folder_id = f.id
             LEFT JOIN message_flag sf ON sf.location_id = ml.id AND sf.flag = ?
             WHERE f.account_id = ?
             GROUP BY f.id, f.path, f.delimiter, f.special_use, f.special_use_override, f.selectable',
            ['\Seen', $accountId],
        )->fetchAll();

        return Json::write($response, ['folders' => self::buildFolderTree($rows)]);
    }

    /** @param array<string, string> $args */
    private function messages(Request $request, Response $response, array $args): Response
    {
        $folderId = strtolower($args['id'] ?? '');
        if (!Uuid::isValid($folderId)) {
            return Json::write($response, ['message' => 'Ordner nicht gefunden.'], 404);
        }
        $query = $request->getQueryParams();
        $limit = self::parseLimit($query['limit'] ?? null);
        $cursor = self::cursorParam($query['cursor'] ?? null);
        if ($limit === null || $cursor === false) {
            return Json::write($response, ['message' => self::BAD_PARAMS], 400);
        }
        $pdo = $this->db->pdo();
        /** @var array{wrapped_dek: string}|false $folder */
        $folder = Database::run(
            $pdo,
            'SELECT a.wrapped_dek FROM folder f JOIN mail_account a ON a.id = f.account_id WHERE f.id = ? AND a.user_id = ?',
            [$folderId, self::session($request)->userId],
        )->fetch();
        if ($folder === false) {
            return Json::write($response, ['message' => 'Ordner nicht gefunden.'], 404);
        }

        [$where, $params] = self::keyset($cursor);
        /** @var list<array<string, mixed>> $rows */
        $rows = Database::run(
            $pdo,
            'SELECT ' . self::LIST_COLUMNS . '
             FROM message_location ml
             JOIN message m ON m.id = ml.message_id
             WHERE ml.folder_id = ?' . $where . '
             ORDER BY ' . self::SORT_AT . ' DESC, ml.id DESC
             LIMIT ' . ($limit + 1),
            [$folderId, ...$params],
        )->fetchAll();

        $dek = Envelope::unwrapAccountKey($this->config->get('MASTER_KEY'), $folder['wrapped_dek']);
        $page = \array_slice($rows, 0, $limit);

        return Json::write($response, [
            'messages' => array_map(fn(array $row): array => $this->toListItem($dek, $row), $page),
            'nextCursor' => self::nextCursor($rows, $page, $limit),
        ]);
    }

    /** @param array<string, string> $args */
    private function message(Request $request, Response $response, array $args): Response
    {
        $messageId = strtolower($args['id'] ?? '');
        if (!Uuid::isValid($messageId)) {
            return Json::write($response, ['message' => 'Nachricht nicht gefunden.'], 404);
        }
        /** @var array<string, mixed>|false $row */
        $row = Database::run(
            $this->db->pdo(),
            self::DETAIL_SELECT . ' WHERE m.id = ? AND a.user_id = ?',
            [$messageId, self::session($request)->userId],
        )->fetch();
        if ($row === false) {
            return Json::write($response, ['message' => 'Nachricht nicht gefunden.'], 404);
        }
        $dek = Envelope::unwrapAccountKey($this->config->get('MASTER_KEY'), (string) $row['wrapped_dek']);

        return Json::write($response, $this->toMessageDetail($dek, $row));
    }

    /** @param array<string, string> $args */
    private function thread(Request $request, Response $response, array $args): Response
    {
        $threadId = strtolower($args['id'] ?? '');
        if (!Uuid::isValid($threadId)) {
            return Json::write($response, ['message' => 'Unterhaltung nicht gefunden.'], 404);
        }
        $userId = self::session($request)->userId;
        $pdo = $this->db->pdo();
        /** @var array{account_id: string, wrapped_dek: string}|false $thread */
        $thread = Database::run(
            $pdo,
            'SELECT t.account_id, a.wrapped_dek FROM thread t JOIN mail_account a ON a.id = t.account_id WHERE t.id = ? AND a.user_id = ?',
            [$threadId, $userId],
        )->fetch();
        if ($thread === false) {
            return Json::write($response, ['message' => 'Unterhaltung nicht gefunden.'], 404);
        }
        // Newest MAX_THREAD_MESSAGES, returned oldest first.
        /** @var list<array<string, mixed>> $rows */
        $rows = Database::run(
            $pdo,
            self::DETAIL_SELECT . '
             WHERE m.thread_id = ? AND m.account_id = ? AND a.user_id = ?
             ORDER BY ' . self::SORT_AT . ' DESC, m.id DESC
             LIMIT ' . self::MAX_THREAD_MESSAGES,
            [$threadId, $thread['account_id'], $userId],
        )->fetchAll();
        $dek = Envelope::unwrapAccountKey($this->config->get('MASTER_KEY'), $thread['wrapped_dek']);
        $messages = array_map(fn(array $row): array => $this->toMessageDetail($dek, $row), array_reverse($rows));
        $newest = $messages === [] ? null : $messages[\count($messages) - 1];

        return Json::write($response, [
            'id' => $threadId,
            'accountId' => $thread['account_id'],
            'subject' => $newest['subject'] ?? '',
            'messages' => $messages,
        ]);
    }

    private function unifiedInbox(Request $request, Response $response): Response
    {
        $userId = self::session($request)->userId;
        $pdo = $this->db->pdo();
        $enabled = (bool) Database::run($pdo, 'SELECT unified_inbox_enabled FROM `user` WHERE id = ?', [$userId])->fetchColumn();
        if (!$enabled) {
            return Json::write($response, ['message' => 'Gemeinsamer Posteingang ist ausgeschaltet.'], 404);
        }
        $query = $request->getQueryParams();
        $limit = self::parseLimit($query['limit'] ?? null);
        $cursor = self::cursorParam($query['cursor'] ?? null);
        if ($limit === null || $cursor === false) {
            return Json::write($response, ['message' => self::BAD_PARAMS], 400);
        }

        // INBOX is identified by its IMAP name (case-insensitive), like the folder tree marks it.
        [$where, $params] = self::keyset($cursor);
        /** @var list<array<string, mixed>> $rows */
        $rows = Database::run(
            $pdo,
            'SELECT ' . self::LIST_COLUMNS . ', m.account_id, ml.folder_id, a.wrapped_dek
             FROM mail_account a
             JOIN folder f ON f.account_id = a.id AND UPPER(f.path) = \'INBOX\'
             JOIN message_location ml ON ml.folder_id = f.id
             JOIN message m ON m.id = ml.message_id
             WHERE a.user_id = ?' . $where . '
             ORDER BY ' . self::SORT_AT . ' DESC, ml.id DESC
             LIMIT ' . ($limit + 1),
            [$userId, ...$params],
        )->fetchAll();

        $deks = [];
        $page = \array_slice($rows, 0, $limit);
        $messages = [];
        foreach ($page as $row) {
            $accountId = (string) $row['account_id'];
            $deks[$accountId] ??= Envelope::unwrapAccountKey($this->config->get('MASTER_KEY'), (string) $row['wrapped_dek']);
            $messages[] = $this->toListItem($deks[$accountId], $row) + ['accountId' => $accountId, 'folderId' => (string) $row['folder_id']];
        }

        return Json::write($response, ['messages' => $messages, 'nextCursor' => self::nextCursor($rows, $page, $limit)]);
    }

    /**
     * Builds the folder tree from flat IMAP paths, in pre-order (parents
     * before children). Folders whose parent is unknown are top-level.
     *
     * @param list<array{id: string, path: string, delimiter: ?string, special_use: ?string, special_use_override?: ?string, selectable?: int|bool, unread_count: int|string, total: int|string}> $rows
     *
     * @return list<array<string, mixed>>
     */
    public static function buildFolderTree(array $rows): array
    {
        $byPath = [];
        foreach ($rows as $row) {
            $byPath[$row['path']] = true;
        }
        /** @var array<string, list<array{id: string, path: string, delimiter: ?string, special_use: ?string, special_use_override?: ?string, selectable?: int|bool, unread_count: int|string, total: int|string}>> $children */
        $children = [];
        foreach ($rows as $row) {
            $parent = self::splitPath($row['path'], $row['delimiter'])[1];
            $key = $parent !== null && isset($byPath[$parent]) ? "p:{$parent}" : 'root';
            $children[$key][] = $row;
        }
        $collator = class_exists(\Collator::class) ? new \Collator('und') : null;
        $collator?->setStrength(\Collator::PRIMARY);
        $compareNames = static function (string $a, string $b) use ($collator): int {
            if ($collator !== null) {
                $result = $collator->compare($a, $b);
                if (\is_int($result)) {
                    return $result;
                }
            }

            return strcmp(mb_strtolower($a), mb_strtolower($b));
        };

        $result = [];
        $visit = static function (string $key, ?string $parentId, int $depth) use (&$visit, &$result, $children, $compareNames): void {
            $siblings = $children[$key] ?? [];
            usort($siblings, static fn(array $a, array $b): int => (self::folderRank($a['path'], $a['special_use']) <=> self::folderRank($b['path'], $b['special_use']))
                ?: $compareNames(self::splitPath($a['path'], $a['delimiter'])[0], self::splitPath($b['path'], $b['delimiter'])[0]));
            foreach ($siblings as $row) {
                $result[] = [
                    'id' => $row['id'],
                    'name' => self::splitPath($row['path'], $row['delimiter'])[0],
                    'path' => $row['path'],
                    'delimiter' => $row['delimiter'],
                    'parentId' => $parentId,
                    'depth' => $depth,
                    'specialUse' => strtoupper($row['path']) === 'INBOX' ? 'inbox' : $row['special_use'],
                    'specialUseOverride' => $row['special_use_override'] ?? null,
                    'selectable' => (bool) ($row['selectable'] ?? true),
                    'unreadCount' => (int) $row['unread_count'],
                    'total' => (int) $row['total'],
                ];
                $visit("p:{$row['path']}", $row['id'], $depth + 1);
            }
        };
        $visit('root', null, 0);

        return $result;
    }

    private static function folderRank(string $path, ?string $specialUse): int
    {
        if (strtoupper($path) === 'INBOX') {
            return 0;
        }

        return self::SPECIAL_USE_RANK[$specialUse ?? ''] ?? 100;
    }

    /** @return array{string, ?string} name and parent path */
    private static function splitPath(string $path, ?string $delimiter): array
    {
        $index = $delimiter !== null && $delimiter !== '' ? strrpos($path, $delimiter) : false;
        if ($delimiter === null || $delimiter === '' || $index === false || $index === 0) {
            return [$path, null];
        }

        return [substr($path, $index + \strlen($delimiter)), substr($path, 0, $index)];
    }

    public static function encodeCursor(string $sortKey, string $locationId): string
    {
        return rtrim(strtr(base64_encode("{$sortKey}|{$locationId}"), '+/', '-_'), '=');
    }

    /**
     * Returns [sortKey as UTC DATETIME(6) text, locationId] or null for
     * malformed cursors.
     *
     * @return array{string, string}|null
     */
    public static function decodeCursor(string $cursor): ?array
    {
        $decoded = base64_decode(strtr($cursor, '-_', '+/'), true);
        if ($decoded === false) {
            return null;
        }
        $index = strrpos($decoded, '|');
        if ($index === false || $index === 0) {
            return null;
        }
        $sortKey = substr($decoded, 0, $index);
        $locationId = strtolower(substr($decoded, $index + 1));
        if (preg_match('/^\d{4}-\d{2}-\d{2}[ T][\d:.]+([+-][\d:]+)?$/', $sortKey) !== 1 || !Uuid::isValid($locationId)) {
            return null;
        }
        try {
            $date = new \DateTimeImmutable($sortKey, new \DateTimeZone('UTC'));
        } catch (\Exception) {
            return null;
        }

        return [$date->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d H:i:s.u'), $locationId];
    }

    public static function parseLimit(mixed $value): ?int
    {
        if ($value === null || $value === '') {
            return self::DEFAULT_LIMIT;
        }
        if (!\is_string($value) || preg_match('/^\s*\+?\d+(\.0*)?\s*$/', $value) !== 1) {
            return null;
        }
        $limit = (int) $value;

        return $limit < 1 ? null : min($limit, self::MAX_LIMIT);
    }

    /**
     * Cursor query parameter: null = none, false = malformed.
     *
     * @return array{string, string}|false|null
     */
    private static function cursorParam(mixed $value): array|false|null
    {
        if ($value === null || $value === '') {
            return null;
        }

        return \is_string($value) ? (self::decodeCursor($value) ?? false) : false;
    }

    /**
     * Keyset condition (sort date, location id) < cursor.
     *
     * @param array{string, string}|null $cursor
     *
     * @return array{string, list<string>}
     */
    public static function keyset(?array $cursor): array
    {
        if ($cursor === null) {
            return ['', []];
        }

        return [
            ' AND (' . self::SORT_AT . ' < ? OR (' . self::SORT_AT . ' = ? AND ml.id < ?))',
            [$cursor[0], $cursor[0], $cursor[1]],
        ];
    }

    /**
     * @param list<array<string, mixed>> $rows
     * @param list<array<string, mixed>> $page
     */
    public static function nextCursor(array $rows, array $page, int $limit): ?string
    {
        $last = $page === [] ? null : $page[\count($page) - 1];
        if (\count($rows) <= $limit || $last === null) {
            return null;
        }

        return self::encodeCursor(self::sortKey((string) $last['sort_at']), (string) $last['location_id']);
    }

    /** DATETIME(6) text with all 6 fractional digits (exact keyset position). */
    private static function sortKey(string $datetime): string
    {
        return (new \DateTimeImmutable($datetime, new \DateTimeZone('UTC')))->format('Y-m-d H:i:s.u');
    }

    /**
     * Decrypted list entry of a LIST_COLUMNS row.
     *
     * @param array<string, mixed> $row
     *
     * @return array<string, mixed>
     */
    public function toListItem(string $dek, array $row): array
    {
        $id = (string) $row['id'];

        return [
            'id' => $id,
            'subject' => $this->decrypt($dek, $row['subject_enc'], 'subject', $id) ?? '',
            'from' => self::toPeople(self::parseJson($this->decrypt($dek, $row['from_enc'], 'from', $id)))[0] ?? null,
            'date' => Sessions::iso((string) $row['sort_at']),
            'snippet' => $this->decrypt($dek, $row['snippet_enc'], 'snippet', $id) ?? '',
            'flags' => self::toFlags($row),
            'hasAttachments' => (bool) $row['has_attachments'],
            'threadId' => \is_string($row['thread_id']) ? $row['thread_id'] : null,
            'threadCount' => (int) $row['thread_count'],
        ];
    }

    /**
     * @param array<string, mixed> $row
     *
     * @return array<string, mixed>
     */
    private function toMessageDetail(string $dek, array $row): array
    {
        $id = (string) $row['id'];
        $recipients = self::parseJson($this->decrypt($dek, $row['recipients_enc'], 'recipients', $id));
        $recipients = \is_array($recipients) ? $recipients : [];
        $deliveredTo = \is_array($recipients['deliveredTo'] ?? null)
            ? array_values(array_filter($recipients['deliveredTo'], is_string(...)))
            : [];
        $references = json_decode((string) $row['references'], true);
        $messageIdHeader = (string) $row['message_id_header'];
        $folderIds = (string) ($row['folder_ids'] ?? '');

        return [
            'id' => $id,
            'accountId' => (string) $row['account_id'],
            'folderIds' => $folderIds === '' ? [] : explode(',', $folderIds),
            'subject' => $this->decrypt($dek, $row['subject_enc'], 'subject', $id) ?? '',
            'from' => self::toPeople(self::parseJson($this->decrypt($dek, $row['from_enc'], 'from', $id)))[0] ?? null,
            'to' => self::toPeople($recipients['to'] ?? null),
            'cc' => self::toPeople($recipients['cc'] ?? null),
            'replyTo' => self::toPeople($recipients['replyTo'] ?? null),
            'deliveredTo' => $deliveredTo,
            'date' => Sessions::iso((string) $row['sort_at']),
            'flags' => self::toFlags($row),
            'hasAttachments' => (bool) $row['has_attachments'],
            // Synthetic ids of messages without a Message-ID are not exposed.
            'messageId' => preg_match(self::FALLBACK_MESSAGE_ID_RE, $messageIdHeader) === 1 ? null : $messageIdHeader,
            'references' => \is_array($references) ? array_values(array_filter($references, is_string(...))) : [],
            'text' => $this->decrypt($dek, $row['text_plain_enc'], 'text', $id),
            'threadId' => \is_string($row['thread_id']) ? $row['thread_id'] : null,
        ];
    }

    /**
     * Decrypts one message field; corrupt ciphertexts degrade to null
     * (logged without content).
     *
     * @param 'subject'|'from'|'recipients'|'snippet'|'body'|'text' $field
     */
    private function decrypt(string $dek, mixed $value, string $field, string $messageId): ?string
    {
        if (!\is_string($value) || $value === '') {
            return null;
        }
        try {
            return Envelope::decryptField($dek, $value, Envelope::messageFieldAad($field, $messageId));
        } catch (\Throwable) {
            $this->logger->warn('message field could not be decrypted', ['messageId' => $messageId, 'field' => $field]);

            return null;
        }
    }

    private static function parseJson(?string $json): mixed
    {
        if ($json === null || $json === '') {
            return null;
        }
        try {
            return json_decode($json, true, 32, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            return null;
        }
    }

    /**
     * Person lists are stored as JSON `[{ name, address }]` (message sync).
     *
     * @return list<array{name: string, address: string}>
     */
    private static function toPeople(mixed $value): array
    {
        if (!\is_array($value)) {
            return [];
        }
        $people = [];
        foreach ($value as $entry) {
            if (\is_array($entry) && \is_string($entry['address'] ?? null)) {
                $name = $entry['name'] ?? '';
                $people[] = ['name' => \is_scalar($name) ? (string) $name : '', 'address' => $entry['address']];
            }
        }

        return $people;
    }

    /**
     * @param array<string, mixed> $row
     *
     * @return array{seen: bool, flagged: bool, answered: bool}
     */
    private static function toFlags(array $row): array
    {
        return ['seen' => (bool) $row['flag_seen'], 'flagged' => (bool) $row['flag_flagged'], 'answered' => (bool) $row['flag_answered']];
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
