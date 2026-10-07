<?php

declare(strict_types=1);

namespace Fma\Routes;

use Fma\Auth\Session;
use Fma\Db\Database;
use Fma\Db\Uuid;
use Fma\Http\Json;
use Fma\Http\Middleware\RequireAuth;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\App;

/**
 * Storage usage per account like apps/api/src/mail/storage.ts (roadmap 5.4):
 * GET /api/accounts/{id}/storage (one own account, 404 otherwise) and
 * GET /api/storage (all accounts plus the total). Summed from database
 * columns only (`message.size_bytes` of messages with a stored raw body,
 * `attachment_upload.size_bytes`), no file system scan. Numbers only.
 */
final class StorageRoutes
{
    public function __construct(private readonly Database $db) {}

    /** @param App<\Psr\Container\ContainerInterface|null> $app */
    public function register(App $app, RequireAuth $requireAuth): void
    {
        $app->get('/api/storage', $this->all(...))->add($requireAuth);
        $app->get('/api/accounts/{id}/storage', $this->one(...))->add($requireAuth);
    }

    /**
     * Storage usage of the user's accounts (or one of them); empty: no such account.
     *
     * @return list<array{accountId: string, messageCount: int, storedMessageCount: int, messageBytes: int, uploadCount: int, uploadBytes: int, totalBytes: int}>
     */
    public function accountStorage(string $userId, ?string $accountId): array
    {
        $rows = Database::run(
            $this->db->pdo(),
            'SELECT acc.id,
               COALESCE(msg.message_count, 0) AS message_count,
               COALESCE(msg.stored_message_count, 0) AS stored_message_count,
               COALESCE(msg.message_bytes, 0) AS message_bytes,
               COALESCE(up.upload_count, 0) AS upload_count,
               COALESCE(up.upload_bytes, 0) AS upload_bytes
             FROM mail_account acc
             LEFT JOIN (
               -- One pass over the user\'s messages (grouped), not one per account.
               SELECT m.account_id,
                 COUNT(*) AS message_count,
                 COUNT(b.message_id) AS stored_message_count,
                 COALESCE(SUM(CASE WHEN b.message_id IS NOT NULL THEN m.size_bytes ELSE 0 END), 0) AS message_bytes
               FROM message m
               JOIN mail_account ma ON ma.id = m.account_id AND ma.user_id = ?
               LEFT JOIN message_body b ON b.message_id = m.id AND b.storage_ref IS NOT NULL
               GROUP BY m.account_id
             ) msg ON msg.account_id = acc.id
             LEFT JOIN (
               SELECT u.account_id, COUNT(*) AS upload_count, COALESCE(SUM(u.size_bytes), 0) AS upload_bytes
               FROM attachment_upload u
               JOIN mail_account ua ON ua.id = u.account_id AND ua.user_id = ?
               GROUP BY u.account_id
             ) up ON up.account_id = acc.id
             WHERE acc.user_id = ? AND (? IS NULL OR acc.id = ?)
             ORDER BY acc.sort_order, acc.created_at',
            [$userId, $userId, $userId, $accountId, $accountId],
        )->fetchAll();

        return array_values(array_map(static function (array $row): array {
            $messageBytes = (int) $row['message_bytes'];
            $uploadBytes = (int) $row['upload_bytes'];

            return [
                'accountId' => (string) $row['id'],
                'messageCount' => (int) $row['message_count'],
                'storedMessageCount' => (int) $row['stored_message_count'],
                'messageBytes' => $messageBytes,
                'uploadCount' => (int) $row['upload_count'],
                'uploadBytes' => $uploadBytes,
                'totalBytes' => $messageBytes + $uploadBytes,
            ];
        }, $rows));
    }

    private function all(Request $request, Response $response): Response
    {
        $accounts = $this->accountStorage(self::session($request)->userId, null);

        return Json::write($response, [
            'accounts' => $accounts,
            'totalBytes' => array_sum(array_column($accounts, 'totalBytes')),
        ]);
    }

    /** @param array<string, string> $args */
    private function one(Request $request, Response $response, array $args): Response
    {
        $accountId = strtolower($args['id'] ?? '');
        $result = Uuid::isValid($accountId) ? ($this->accountStorage(self::session($request)->userId, $accountId)[0] ?? null) : null;
        if ($result === null) {
            return Json::write($response, ['message' => 'Konto nicht gefunden.'], 404);
        }

        return Json::write($response, $result);
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
