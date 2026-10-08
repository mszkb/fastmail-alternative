<?php

declare(strict_types=1);

namespace Fma\Routes;

use Fma\Auth\Session;
use Fma\Db\Database;
use Fma\Db\Sequence;
use Fma\Db\Uuid;
use Fma\Http\Body;
use Fma\Http\Json;
use Fma\Http\Middleware\RequireAuth;
use Fma\Jobs\JobQueue;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\App;

/**
 * POST /api/messages/actions (roadmap 2.4): read/unread, flag, archive, delete, move.
 *
 * Optimistic write-through: the change is applied to the database right
 * away (message_flag rows, moved/removed locations) and in the same
 * transaction a `message_action` job is enqueued per (folder,
 * uidvalidity); the worker writes it back to the IMAP server. Moves leave
 * a placeholder location (uidvalidity 0, negative uid from the
 * `message_location_placeholder` sequence) until the real UID is known;
 * actions on placeholders answer 409.
 */
final class MessageActionRoutes
{
    public const ACTIONS = ['read', 'unread', 'flag', 'unflag', 'archive', 'delete', 'move'];
    public const MAX_BATCH = 100;

    /** Flag changes per action: [flag, add?]. */
    private const FLAG_ACTIONS = [
        'read' => ['\Seen', true],
        'unread' => ['\Seen', false],
        'flag' => ['\Flagged', true],
        'unflag' => ['\Flagged', false],
    ];

    public function __construct(private readonly Database $db, private readonly JobQueue $jobs) {}

    /** @param App<\Psr\Container\ContainerInterface|null> $app */
    public function register(App $app, RequireAuth $requireAuth): void
    {
        $app->post('/api/messages/actions', $this->action(...))->add($requireAuth);
    }

    private function action(Request $request, Response $response): Response
    {
        $parsed = self::parseRequest(Body::json($request));
        if ($parsed === null) {
            return Json::write($response, ['message' => 'Ungültige Aktion (Ordner, Aktion, 1-' . self::MAX_BATCH . ' Nachrichten, Zielordner prüfen).'], 400);
        }
        $pdo = $this->db->pdo();
        $pdo->beginTransaction();
        try {
            $updated = $this->apply($pdo, self::session($request)->userId, $parsed);
            $pdo->commit();
        } catch (MessageActionException $e) {
            $pdo->rollBack();

            return Json::write($response, ['message' => $e->getMessage()], $e->statusCode);
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }

        return Json::write($response, ['updated' => $updated]);
    }

    /**
     * @param array<mixed> $body
     *
     * @return array{folderId: string, messageIds: list<string>, action: string, targetFolderId: ?string}|null
     */
    private static function parseRequest(array $body): ?array
    {
        $folderId = $body['folderId'] ?? null;
        $action = $body['action'] ?? null;
        $messageIds = $body['messageIds'] ?? null;
        $target = $body['targetFolderId'] ?? null;
        if (!\is_string($folderId) || !Uuid::isValid(strtolower($folderId))) {
            return null;
        }
        if (!\is_string($action) || !\in_array($action, self::ACTIONS, true)) {
            return null;
        }
        if (!\is_array($messageIds) || !array_is_list($messageIds) || $messageIds === [] || \count($messageIds) > self::MAX_BATCH) {
            return null;
        }
        $ids = [];
        foreach ($messageIds as $id) {
            if (!\is_string($id) || !Uuid::isValid(strtolower($id))) {
                return null;
            }
            $ids[strtolower($id)] = true;
        }
        if ($action === 'move' && (!\is_string($target) || !Uuid::isValid(strtolower($target)))) {
            return null;
        }

        return [
            'folderId' => strtolower($folderId),
            'messageIds' => array_keys($ids),
            'action' => $action,
            'targetFolderId' => $action === 'move' ? strtolower((string) $target) : null,
        ];
    }

    /**
     * @param array{folderId: string, messageIds: list<string>, action: string, targetFolderId: ?string} $request
     */
    private function apply(\PDO $pdo, string $userId, array $request): int
    {
        /** @var array{id: string, account_id: string, special_use: ?string}|false $source */
        $source = Database::run(
            $pdo,
            'SELECT f.id, f.account_id, f.special_use
             FROM folder f JOIN mail_account a ON a.id = f.account_id
             WHERE f.id = ? AND a.user_id = ?
             FOR UPDATE',
            [$request['folderId'], $userId],
        )->fetch();
        if ($source === false) {
            throw new MessageActionException(404, 'Ordner nicht gefunden.');
        }

        // Lock the affected locations: concurrent actions/syncs serialize.
        $in = implode(', ', array_fill(0, \count($request['messageIds']), '?'));
        /** @var list<array{id: string, message_id: string, uidvalidity: int|string, uid: int|string}> $locations */
        $locations = Database::run(
            $pdo,
            "SELECT id, message_id, uidvalidity, uid FROM message_location
             WHERE folder_id = ? AND message_id IN ({$in})
             ORDER BY uid
             FOR UPDATE",
            [$source['id'], ...$request['messageIds']],
        )->fetchAll();
        $found = array_flip(array_column($locations, 'message_id'));
        foreach ($request['messageIds'] as $id) {
            if (!isset($found[$id])) {
                throw new MessageActionException(404, 'Nachricht nicht gefunden.');
            }
        }
        foreach ($locations as $row) {
            if ((int) $row['uid'] <= 0) {
                throw new MessageActionException(409, 'Die Nachricht wird gerade noch verschoben. Bitte gleich noch einmal versuchen.');
            }
        }

        $target = self::resolveTarget($pdo, $source, $request);
        $locationIds = array_column($locations, 'id');
        $locIn = implode(', ', array_fill(0, \count($locationIds), '?'));
        $flagChange = self::FLAG_ACTIONS[$request['action']] ?? null;

        if ($flagChange !== null) {
            [$flag, $add] = $flagChange;
            if ($add) {
                $values = implode(', ', array_fill(0, \count($locationIds), '(?, ?)'));
                $params = [];
                foreach ($locationIds as $id) {
                    array_push($params, $id, $flag);
                }
                Database::run($pdo, "INSERT IGNORE INTO message_flag (location_id, flag) VALUES {$values}", $params);
            } else {
                Database::run($pdo, "DELETE FROM message_flag WHERE location_id IN ({$locIn}) AND flag = ?", [...$locationIds, $flag]);
            }
            $operation = $request['action'];
        } elseif ($target !== null) {
            // Optimistic move: the location becomes a placeholder in the target folder.
            foreach ($locationIds as $id) {
                $placeholder = -Sequence::next($pdo, 'message_location_placeholder');
                Database::run($pdo, 'UPDATE message_location SET folder_id = ?, uidvalidity = 0, uid = ? WHERE id = ?', [$target['id'], $placeholder, $id]);
            }
            $operation = 'move';
        } else {
            // Permanent delete from Trash: drop the location now; the job expunges on the server.
            Database::run($pdo, "DELETE FROM message_location WHERE id IN ({$locIn})", $locationIds);
            $operation = 'expunge';
        }

        // One write-back job per uidvalidity (normally exactly one).
        $groups = [];
        foreach ($locations as $row) {
            $groups[(string) $row['uidvalidity']][] = $row;
        }
        foreach ($groups as $uidvalidity => $rows) {
            $payload = [
                'operation' => $operation,
                'folderId' => $source['id'],
                'uidvalidity' => (string) $uidvalidity,
                'items' => array_map(static fn(array $row): array => [
                    'uid' => (int) $row['uid'],
                    'locationId' => $row['id'],
                    'messageId' => $row['message_id'],
                ], $rows),
            ];
            if ($target !== null) {
                $payload['targetFolderId'] = $target['id'];
            }
            $this->jobs->enqueue('message_action', $source['account_id'], $payload);
        }

        return \count($locations);
    }

    /**
     * Target folder of a move-like action (null: flag action or permanent delete).
     *
     * @param array{id: string, account_id: string, special_use: ?string} $source
     * @param array{folderId: string, messageIds: list<string>, action: string, targetFolderId: ?string} $request
     *
     * @return array{id: string, account_id: string, special_use: ?string}|null
     */
    private static function resolveTarget(\PDO $pdo, array $source, array $request): ?array
    {
        $bySpecialUse = static function (string $specialUse) use ($pdo, $source): ?array {
            /** @var array{id: string, account_id: string, special_use: ?string}|false $row */
            $row = Database::run(
                $pdo,
                'SELECT id, account_id, special_use FROM folder WHERE account_id = ? AND special_use = ? ORDER BY path LIMIT 1',
                [$source['account_id'], $specialUse],
            )->fetch();

            return $row === false ? null : $row;
        };

        switch ($request['action']) {
            case 'archive':
                if ($source['special_use'] === 'archive') {
                    throw new MessageActionException(400, 'Die Nachricht ist bereits im Archiv.');
                }

                return $bySpecialUse('archive') ?? throw new MessageActionException(409, 'Für dieses Konto gibt es keinen Archiv-Ordner.');
            case 'delete':
                // Inside Trash, delete means permanently (\Deleted + EXPUNGE).
                if ($source['special_use'] === 'trash') {
                    return null;
                }

                return $bySpecialUse('trash') ?? throw new MessageActionException(409, 'Für dieses Konto gibt es keinen Papierkorb-Ordner.');
            case 'move':
                /** @var array{id: string, account_id: string, special_use: ?string}|false $target */
                $target = Database::run(
                    $pdo,
                    'SELECT id, account_id, special_use FROM folder WHERE id = ? AND account_id = ? AND selectable',
                    [$request['targetFolderId'], $source['account_id']],
                )->fetch();
                if ($target === false) {
                    throw new MessageActionException(404, 'Zielordner nicht gefunden.');
                }
                if ($target['id'] === $source['id']) {
                    throw new MessageActionException(400, 'Die Nachricht ist bereits in diesem Ordner.');
                }

                return $target;
            default:
                return null;
        }
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
