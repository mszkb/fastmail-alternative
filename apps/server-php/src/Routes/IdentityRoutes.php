<?php

declare(strict_types=1);

namespace Fma\Routes;

use Fma\Auth\Session;
use Fma\Db\Database;
use Fma\Db\Uuid;
use Fma\Http\Body;
use Fma\Http\Input;
use Fma\Http\Json;
use Fma\Http\Middleware\RequireAuth;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\App;

/**
 * Sender identities of an account like apps/api/src/mail/identities.ts
 * (roadmap 2.6, 3.6): list, add an alias (unique per account,
 * case-insensitive, 409), change name/signature or make it the default,
 * remove (not the default one, 409).
 *
 * Default: mail_account.default_identity_id, else the identity matching
 * the account address. Ownership is checked via mail_account.user_id;
 * foreign or unknown ids answer 404.
 */
final class IdentityRoutes
{
    public const MAX_IDENTITIES_PER_ACCOUNT = 20;
    public const MAX_IDENTITY_NAME_LENGTH = 100;
    public const MAX_SIGNATURE_LENGTH = 10_000;
    private const EMAIL_RE = '/^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+\z/u';
    private const MAX_EMAIL_LENGTH = 254;

    /** SQL: is identity `i` the default of account `a`? */
    public const IDENTITY_IS_DEFAULT = '(CASE WHEN a.default_identity_id IS NOT NULL
        THEN i.id = a.default_identity_id
        ELSE i.email_address_lower = LOWER(a.email_address) END)';

    private const IDENTITY_COLUMNS = 'i.id, i.name, i.email_address, i.signature, ' . self::IDENTITY_IS_DEFAULT . ' AS is_default';

    public function __construct(private readonly Database $db) {}

    /** @param App<\Psr\Container\ContainerInterface|null> $app */
    public function register(App $app, RequireAuth $requireAuth): void
    {
        $app->get('/api/accounts/{id}/identities', $this->list(...))->add($requireAuth);
        $app->post('/api/accounts/{id}/identities', $this->create(...))->add($requireAuth);
        $app->patch('/api/identities/{id}', $this->update(...))->add($requireAuth);
        $app->delete('/api/identities/{id}', $this->delete(...))->add($requireAuth);
    }

    /** @param array<string, string> $args */
    private function list(Request $request, Response $response, array $args): Response
    {
        $accountId = strtolower($args['id'] ?? '');
        if (!$this->ownsAccount($accountId, self::session($request)->userId)) {
            return Json::write($response, ['message' => 'Konto nicht gefunden.'], 404);
        }
        $rows = Database::run(
            $this->db->pdo(),
            'SELECT ' . self::IDENTITY_COLUMNS . '
             FROM identity i JOIN mail_account a ON a.id = i.account_id
             WHERE i.account_id = ?
             ORDER BY is_default DESC, i.email_address, i.id',
            [$accountId],
        )->fetchAll();

        return Json::write($response, ['identities' => array_map(self::toIdentity(...), $rows)]);
    }

    /** @param array<string, string> $args */
    private function create(Request $request, Response $response, array $args): Response
    {
        $input = Body::json($request);
        $email = self::parseEmail($input['emailAddress'] ?? null);
        $name = self::parseName($input['name'] ?? '');
        $signature = self::parseSignature($input['signature'] ?? null);
        foreach ([$email, $name, $signature] as $parsed) {
            if (!$parsed['ok']) {
                return Json::write($response, ['message' => $parsed['message']], 400);
            }
        }
        $userId = self::session($request)->userId;
        $accountId = strtolower($args['id'] ?? '');
        if (!$this->ownsAccount($accountId, $userId)) {
            return Json::write($response, ['message' => 'Konto nicht gefunden.'], 404);
        }
        $pdo = $this->db->pdo();
        $count = (int) Database::run($pdo, 'SELECT COUNT(*) FROM identity WHERE account_id = ?', [$accountId])->fetchColumn();
        if ($count >= self::MAX_IDENTITIES_PER_ACCOUNT) {
            return Json::write($response, ['message' => 'Zu viele Identitäten für dieses Konto.'], 409);
        }
        $id = Uuid::v4();
        try {
            Database::run(
                $pdo,
                'INSERT INTO identity (id, account_id, name, email_address, signature) VALUES (?, ?, ?, ?, ?)',
                [$id, $accountId, $name['value'] ?? '', $email['value'] ?? '', $signature['value'] ?? null],
            );
        } catch (\PDOException $e) {
            if (!self::isUniqueViolation($e)) {
                throw $e;
            }

            return Json::write($response, ['message' => 'Diese Adresse ist für das Konto bereits eingetragen.'], 409);
        }

        return Json::write($response, ['identity' => self::toIdentity($this->loadIdentity($id, $userId) ?? throw new \RuntimeException('identity row missing'))], 201);
    }

    /** @param array<string, string> $args */
    private function update(Request $request, Response $response, array $args): Response
    {
        $input = Body::json($request);
        $name = \array_key_exists('name', $input) ? self::parseName($input['name']) : null;
        $signature = \array_key_exists('signature', $input) ? self::parseSignature($input['signature']) : null;
        $hasDefault = \array_key_exists('isDefault', $input);
        if ($name === null && $signature === null && !$hasDefault) {
            return Json::write($response, ['message' => 'Keine Änderung angegeben.'], 400);
        }
        if ($hasDefault && $input['isDefault'] !== true) {
            return Json::write($response, ['message' => 'Eine andere Identität als Standard wählen, um diese abzulösen.'], 400);
        }
        foreach ([$name, $signature] as $parsed) {
            if ($parsed !== null && !$parsed['ok']) {
                return Json::write($response, ['message' => $parsed['message']], 400);
            }
        }
        $userId = self::session($request)->userId;
        $identity = $this->loadIdentity(strtolower($args['id'] ?? ''), $userId);
        if ($identity === null) {
            return Json::write($response, ['message' => 'Identität nicht gefunden.'], 404);
        }

        $pdo = $this->db->pdo();
        $sets = [];
        $values = [];
        if ($name !== null) {
            $sets[] = 'name = ?';
            $values[] = $name['value'] ?? '';
        }
        if ($signature !== null) {
            $sets[] = 'signature = ?';
            $values[] = $signature['value'] ?? null;
        }
        if ($sets !== []) {
            Database::run($pdo, 'UPDATE identity SET ' . implode(', ', $sets) . ' WHERE id = ?', [...$values, $identity['id']]);
        }
        if ($hasDefault) {
            Database::run(
                $pdo,
                'UPDATE mail_account a JOIN identity i ON a.id = i.account_id SET a.default_identity_id = i.id WHERE i.id = ?',
                [$identity['id']],
            );
        }

        return Json::write($response, ['identity' => self::toIdentity($this->loadIdentity($identity['id'], $userId) ?? throw new \RuntimeException('identity row missing'))]);
    }

    /** @param array<string, string> $args */
    private function delete(Request $request, Response $response, array $args): Response
    {
        $identity = $this->loadIdentity(strtolower($args['id'] ?? ''), self::session($request)->userId);
        if ($identity === null) {
            return Json::write($response, ['message' => 'Identität nicht gefunden.'], 404);
        }
        if ((bool) $identity['is_default']) {
            return Json::write($response, ['message' => 'Die Standard-Identität kann nicht entfernt werden.'], 409);
        }
        Database::run($this->db->pdo(), 'DELETE FROM identity WHERE id = ?', [$identity['id']]);

        return $response->withStatus(204);
    }

    private function ownsAccount(string $accountId, string $userId): bool
    {
        return Uuid::isValid($accountId)
            && Database::run($this->db->pdo(), 'SELECT 1 FROM mail_account WHERE id = ? AND user_id = ?', [$accountId, $userId])->fetchColumn() !== false;
    }

    /** @return array{id: string, name: string, email_address: string, signature: ?string, is_default: int|bool}|null */
    private function loadIdentity(string $id, string $userId): ?array
    {
        if (!Uuid::isValid($id)) {
            return null;
        }
        /** @var array{id: string, name: string, email_address: string, signature: ?string, is_default: int|bool}|false $row */
        $row = Database::run(
            $this->db->pdo(),
            'SELECT ' . self::IDENTITY_COLUMNS . '
             FROM identity i JOIN mail_account a ON a.id = i.account_id
             WHERE i.id = ? AND a.user_id = ?',
            [$id, $userId],
        )->fetch();

        return $row === false ? null : $row;
    }

    /**
     * @param array<string, mixed> $row
     *
     * @return array{id: mixed, name: mixed, emailAddress: mixed, signature: mixed, isDefault: bool}
     */
    private static function toIdentity(array $row): array
    {
        return [
            'id' => $row['id'],
            'name' => $row['name'],
            'emailAddress' => $row['email_address'],
            'signature' => $row['signature'],
            'isDefault' => (bool) $row['is_default'],
        ];
    }

    /**
     * Display name: single line, trimmed.
     *
     * @return array{ok: true, value: string}|array{ok: false, message: string}
     */
    private static function parseName(mixed $value): array
    {
        if (!\is_string($value)) {
            return ['ok' => false, 'message' => 'Ungültiger Name.'];
        }
        $name = Input::trim(preg_replace('/[\r\n\t]+/', ' ', $value) ?? $value);
        if (self::jsLength($name) > self::MAX_IDENTITY_NAME_LENGTH) {
            return ['ok' => false, 'message' => 'Der Name ist zu lang.'];
        }

        return ['ok' => true, 'value' => $name];
    }

    /**
     * Signature: CRLF normalized, trailing whitespace removed, empty = null.
     *
     * @return array{ok: true, value: ?string}|array{ok: false, message: string}
     */
    private static function parseSignature(mixed $value): array
    {
        if ($value !== null && !\is_string($value)) {
            return ['ok' => false, 'message' => 'Ungültige Signatur.'];
        }
        $signature = \is_string($value)
            ? preg_replace('/[' . Input::WS . ']+\z/u', '', preg_replace('/\r\n?/', "\n", $value) ?? $value) ?? $value
            : null;
        if ($signature !== null && self::jsLength($signature) > self::MAX_SIGNATURE_LENGTH) {
            return ['ok' => false, 'message' => 'Die Signatur ist zu lang.'];
        }

        return ['ok' => true, 'value' => $signature === '' ? null : $signature];
    }

    /** @return array{ok: true, value: string}|array{ok: false, message: string} */
    private static function parseEmail(mixed $value): array
    {
        $email = \is_string($value) ? mb_strtolower(Input::trim($value)) : '';
        if (self::jsLength($email) > self::MAX_EMAIL_LENGTH || preg_match(self::EMAIL_RE, $email) !== 1) {
            return ['ok' => false, 'message' => 'Ungültige E-Mail-Adresse.'];
        }

        return ['ok' => true, 'value' => $email];
    }

    /** String length in UTF-16 code units, like JavaScript's `.length`. */
    private static function jsLength(string $value): int
    {
        return intdiv(\strlen((string) mb_convert_encoding($value, 'UTF-16LE', 'UTF-8')), 2);
    }

    /** Duplicate key (MySQL error 1062) on the unique (account_id, email_address_lower) index. */
    private static function isUniqueViolation(\PDOException $e): bool
    {
        return ($e->errorInfo[1] ?? null) === 1062;
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
