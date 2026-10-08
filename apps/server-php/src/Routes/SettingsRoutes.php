<?php

declare(strict_types=1);

namespace Fma\Routes;

use Fma\Auth\Session;
use Fma\Db\Database;
use Fma\Http\Body;
use Fma\Http\Json;
use Fma\Http\Middleware\RequireAuth;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\App;

/**
 * GET/PUT /api/settings (roadmap 3.7,
 * principle 8): the unified inbox is off until the user switches it on.
 */
final class SettingsRoutes
{
    public function __construct(private readonly Database $db) {}

    /** @param App<\Psr\Container\ContainerInterface|null> $app */
    public function register(App $app, RequireAuth $requireAuth): void
    {
        $app->get('/api/settings', $this->get(...))->add($requireAuth);
        $app->put('/api/settings', $this->put(...))->add($requireAuth);
    }

    /** @return array{unifiedInbox: bool} */
    public static function load(Database $db, string $userId): array
    {
        $value = Database::run($db->pdo(), 'SELECT unified_inbox_enabled FROM `user` WHERE id = ?', [$userId])->fetchColumn();

        return ['unifiedInbox' => $value !== false && (bool) $value];
    }

    private function get(Request $request, Response $response): Response
    {
        return Json::write($response, self::load($this->db, self::session($request)->userId));
    }

    private function put(Request $request, Response $response): Response
    {
        $value = Body::json($request)['unifiedInbox'] ?? null;
        if (!\is_bool($value)) {
            return Json::write($response, ['message' => 'Ungültige Einstellungen.'], 400);
        }
        $userId = self::session($request)->userId;
        Database::run($this->db->pdo(), 'UPDATE `user` SET unified_inbox_enabled = ? WHERE id = ?', [$value ? 1 : 0, $userId]);

        return Json::write($response, self::load($this->db, $userId));
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
