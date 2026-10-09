<?php

declare(strict_types=1);

namespace Fma\Routes;

use Fma\Auth\Session;
use Fma\Auth\Sessions;
use Fma\Db\Database;
use Fma\Http\Json;
use Fma\Http\Middleware\RequireAuth;
use Fma\Themes\ThemeValidator;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\App;

/**
 * Installed themes per user (#126): GET /api/themes, POST /api/themes (the
 * theme file as JSON body; the same id replaces an installed theme),
 * DELETE /api/themes/{id}. Files are validated by ThemeValidator; the
 * active theme is a per-device choice of the client.
 */
final class ThemeRoutes
{
    public function __construct(private readonly Database $db) {}

    /** @param App<\Psr\Container\ContainerInterface|null> $app */
    public function register(App $app, RequireAuth $requireAuth): void
    {
        $app->get('/api/themes', $this->list(...))->add($requireAuth);
        $app->post('/api/themes', $this->install(...))->add($requireAuth);
        $app->delete('/api/themes/{id}', $this->remove(...))->add($requireAuth);
    }

    private function list(Request $request, Response $response): Response
    {
        /** @var list<array{theme_id: string, name: string, version: string, content: string, installed_at: string}> $rows */
        $rows = Database::run(
            $this->db->pdo(),
            'SELECT theme_id, name, version, content, installed_at FROM user_theme WHERE user_id = ? ORDER BY name, theme_id',
            [self::session($request)->userId],
        )->fetchAll();

        return Json::write($response, ['themes' => array_map(self::toItem(...), $rows)]);
    }

    private function install(Request $request, Response $response): Response
    {
        $raw = (string) $request->getBody();
        if (\strlen($raw) > ThemeValidator::MAX_BYTES) {
            return Json::write($response, ['message' => 'Die Datei ist größer als 32 KB.', 'errors' => ['Die Datei ist größer als 32 KB.']], 413);
        }
        try {
            $theme = json_decode($raw, true, 16, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            return Json::write($response, ['message' => 'Die Datei ist kein gültiges JSON.', 'errors' => ['Die Datei ist kein gültiges JSON.']], 400);
        }
        $errors = ThemeValidator::validate($theme);
        if ($errors !== [] || !\is_array($theme)) {
            return Json::write($response, ['message' => 'Das Theme ist ungültig.', 'errors' => $errors], 400);
        }
        $userId = self::session($request)->userId;
        $pdo = $this->db->pdo();
        /** @var string $id */
        $id = $theme['id'];
        $exists = Database::run($pdo, 'SELECT 1 FROM user_theme WHERE user_id = ? AND theme_id = ?', [$userId, $id])->fetchColumn() !== false;
        $count = (int) Database::run($pdo, 'SELECT COUNT(*) FROM user_theme WHERE user_id = ?', [$userId])->fetchColumn();
        if (!$exists && $count >= ThemeValidator::MAX_INSTALLED) {
            return Json::write($response, ['message' => 'Es sind bereits ' . ThemeValidator::MAX_INSTALLED . ' Themes installiert. Bitte zuerst eines löschen.'], 409);
        }
        // Stored re-encoded (objects stay objects, e.g. an empty "colors": {}).
        $normalized = json_encode(json_decode($raw, false, 16, JSON_THROW_ON_ERROR), JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        Database::run(
            $pdo,
            'INSERT INTO user_theme (user_id, theme_id, name, version, content) VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE name = VALUES(name), version = VALUES(version), content = VALUES(content), installed_at = CURRENT_TIMESTAMP(6)',
            [$userId, $id, $theme['name'], $theme['version'], $normalized],
        );
        /** @var array{theme_id: string, name: string, version: string, content: string, installed_at: string} $row */
        $row = Database::run($pdo, 'SELECT theme_id, name, version, content, installed_at FROM user_theme WHERE user_id = ? AND theme_id = ?', [$userId, $id])->fetch();

        return Json::write($response, self::toItem($row), $exists ? 200 : 201);
    }

    /** @param array<string, string> $args */
    private function remove(Request $request, Response $response, array $args): Response
    {
        $deleted = Database::run(
            $this->db->pdo(),
            'DELETE FROM user_theme WHERE user_id = ? AND theme_id = ?',
            [self::session($request)->userId, $args['id'] ?? ''],
        )->rowCount();

        return $deleted > 0 ? $response->withStatus(204) : Json::write($response, ['message' => 'Theme nicht gefunden.'], 404);
    }

    /**
     * @param array{theme_id: string, name: string, version: string, content: string, installed_at: string} $row
     *
     * @return array<string, mixed>
     */
    private static function toItem(array $row): array
    {
        return [
            'id' => $row['theme_id'],
            'name' => $row['name'],
            'version' => $row['version'],
            'installedAt' => Sessions::iso($row['installed_at']),
            'theme' => json_decode($row['content'], false, 16, JSON_THROW_ON_ERROR),
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
