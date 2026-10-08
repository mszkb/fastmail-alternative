<?php

declare(strict_types=1);

namespace Fma\Routes;

use Fma\Auth\Session;
use Fma\Db\Database;
use Fma\Db\Uuid;
use Fma\Http\Body;
use Fma\Http\Json;
use Fma\Http\Middleware\RequireAuth;
use Fma\Jobs\JobQueue;
use Fma\Mail\FolderRoles;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\App;

/**
 * Folder role mapping and loading older messages (roadmap 3.3, 2.2):
 * - PATCH /api/folders/{id} stores special_use_override (never touched by
 *   folder_sync; a role moves away from any other folder of the account)
 *   and recomputes the effective special_use right away.
 * - POST /api/folders/{id}/load-older enqueues a message_sync with
 *   loadOlder; at most one such job per folder is queued or running.
 * Ownership via mail_account.user_id; foreign/unknown ids answer 404.
 */
final class FolderRoutes
{
    private const NOT_FOUND = 'Ordner nicht gefunden.';
    private const NOT_SELECTABLE = 'Dieser Ordner kann keine Nachrichten enthalten.';

    public function __construct(private readonly Database $db, private readonly JobQueue $jobs) {}

    /** @param App<\Psr\Container\ContainerInterface|null> $app */
    public function register(App $app, RequireAuth $requireAuth): void
    {
        $app->patch('/api/folders/{id}', $this->update(...))->add($requireAuth);
        $app->post('/api/folders/{id}/load-older', $this->loadOlder(...))->add($requireAuth);
    }

    /** @param array<string, string> $args */
    private function update(Request $request, Response $response, array $args): Response
    {
        $input = Body::json($request);
        if (!\array_key_exists('specialUse', $input) || ($input['specialUse'] !== null && !FolderRoles::isRole($input['specialUse']))) {
            return Json::write($response, ['message' => 'Ungültige Ordnerrolle.'], 400);
        }
        /** @var ?string $role */
        $role = $input['specialUse'];
        $folderId = strtolower($args['id'] ?? '');
        if (!Uuid::isValid($folderId)) {
            return Json::write($response, ['message' => self::NOT_FOUND], 404);
        }

        $pdo = $this->db->pdo();
        $pdo->beginTransaction();
        try {
            /** @var array{account_id: string, path: string, selectable: int|bool}|false $row */
            $row = Database::run(
                $pdo,
                'SELECT f.account_id, f.path, f.selectable FROM folder f
                 JOIN mail_account a ON a.id = f.account_id
                 WHERE f.id = ? AND a.user_id = ?
                 FOR UPDATE',
                [$folderId, self::session($request)->userId],
            )->fetch();
            if ($row === false) {
                $pdo->rollBack();

                return Json::write($response, ['message' => self::NOT_FOUND], 404);
            }
            if ($role !== null && !(bool) $row['selectable']) {
                $pdo->rollBack();

                return Json::write($response, ['message' => self::NOT_SELECTABLE], 400);
            }
            if ($role !== null && strtoupper($row['path']) === 'INBOX') {
                $pdo->rollBack();

                return Json::write($response, ['message' => 'Der Posteingang kann keine andere Rolle haben.'], 400);
            }
            // Serializes concurrent mapping changes of the same account.
            Database::run($pdo, 'SELECT 1 FROM mail_account WHERE id = ? FOR UPDATE', [$row['account_id']]);
            if ($role !== null) {
                Database::run(
                    $pdo,
                    'UPDATE folder SET special_use_override = NULL WHERE account_id = ? AND special_use_override = ? AND id <> ?',
                    [$row['account_id'], $role, $folderId],
                );
            }
            Database::run($pdo, 'UPDATE folder SET special_use_override = ? WHERE id = ?', [$role, $folderId]);
            FolderRoles::apply($pdo, $row['account_id']);
            $pdo->commit();
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }

        return $response->withStatus(204);
    }

    /** @param array<string, string> $args */
    private function loadOlder(Request $request, Response $response, array $args): Response
    {
        $folderId = strtolower($args['id'] ?? '');
        if (!Uuid::isValid($folderId)) {
            return Json::write($response, ['message' => self::NOT_FOUND], 404);
        }
        $pdo = $this->db->pdo();
        $pdo->beginTransaction();
        try {
            // The folder row lock serializes concurrent requests for the same folder.
            /** @var array{account_id: string, selectable: int|bool}|false $row */
            $row = Database::run(
                $pdo,
                'SELECT f.account_id, f.selectable FROM folder f
                 JOIN mail_account a ON a.id = f.account_id
                 WHERE f.id = ? AND a.user_id = ?
                 FOR UPDATE',
                [$folderId, self::session($request)->userId],
            )->fetch();
            if ($row === false) {
                $pdo->rollBack();

                return Json::write($response, ['message' => self::NOT_FOUND], 404);
            }
            if (!(bool) $row['selectable']) {
                $pdo->rollBack();

                return Json::write($response, ['message' => self::NOT_SELECTABLE], 400);
            }
            $pending = Database::run(
                $pdo,
                "SELECT 1 FROM job
                 WHERE type = 'message_sync' AND account_id = ?
                   AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.folderId')) = ?
                   AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.loadOlder')) = 'true'
                   AND state IN ('queued', 'running')
                 LIMIT 1",
                [$row['account_id'], $folderId],
            )->fetchColumn() !== false;
            if (!$pending) {
                $this->jobs->enqueue('message_sync', $row['account_id'], ['folderId' => $folderId, 'loadOlder' => true]);
            }
            $pdo->commit();
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }

        return Json::write($response, ['queued' => !$pending], 202);
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
