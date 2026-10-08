<?php

declare(strict_types=1);

namespace Fma\Routes;

use Fma\Auth\Authenticator;
use Fma\Auth\Password;
use Fma\Auth\Session;
use Fma\Auth\SessionCookie;
use Fma\Auth\Sessions;
use Fma\Auth\SetupCode;
use Fma\Db\Database;
use Fma\Db\Uuid;
use Fma\Http\Body;
use Fma\Http\Json;
use Fma\Http\Middleware\RequireAuth;
use Fma\Log\Logger;
use Fma\Security\ClientIp;
use Fma\Security\LoginLockout;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\App;

/**
 * /api/auth/* (ADR-0004): single-user
 * setup with setup code, password login with lockout, server-side
 * sessions, logout, password change and device management.
 */
final class AuthRoutes
{
    private const EMAIL_RE = '/^[^\s@]+@[^\s@]+\.[^\s@]+$/u';
    private const PLATFORMS = ['ios_pwa', 'android_pwa', 'desktop'];
    private const SETUP_LOCK = 'fma-setup';

    public function __construct(
        private readonly Database $db,
        private readonly Sessions $sessions,
        private readonly Authenticator $auth,
        private readonly SessionCookie $cookie,
        private readonly SetupCode $setupCode,
        private readonly LoginLockout $lockout,
        private readonly Logger $logger,
    ) {}

    /** @param App<\Psr\Container\ContainerInterface|null> $app */
    public function register(App $app, RequireAuth $requireAuth): void
    {
        $app->get('/api/auth/status', $this->status(...));
        $app->post('/api/auth/setup', $this->setup(...));
        $app->post('/api/auth/login', $this->login(...));
        $app->post('/api/auth/password', $this->password(...))->add($requireAuth);
        $app->delete('/api/auth/session', $this->logout(...))->add($requireAuth);
        $app->get('/api/auth/devices', $this->devices(...))->add($requireAuth);
        $app->delete('/api/auth/devices/{id}', $this->revokeDevice(...))->add($requireAuth);
    }

    private function status(Request $request, Response $response): Response
    {
        $needsSetup = !$this->userExists();
        if ($needsSetup) {
            $this->setupCode->ensure();
        }
        [$session, $rotated] = $this->auth->resolve($request);
        $body = ['needsSetup' => $needsSetup, 'authenticated' => $session !== null]
            + ($session !== null ? ['email' => $session->email] : []);

        return $this->auth->finish(Json::write($response, $body), $rotated);
    }

    private function setup(Request $request, Response $response): Response
    {
        if ($this->userExists()) {
            return Json::write($response, ['message' => 'Setup already completed'], 403);
        }
        // A fresh instance is reachable by anyone: only whoever can read the log (or config) may claim it.
        $this->setupCode->ensure();
        $body = Body::json($request);
        if (!$this->setupCode->matches($body['setupCode'] ?? null)) {
            $this->logger->warn('setup rejected: invalid setup code', ['event' => 'auth.setup_code_invalid']);

            return Json::write($response, ['message' => 'Invalid setup code'], 403);
        }
        $credentials = self::readCredentials($body);
        if ($credentials === null) {
            return Json::write($response, ['message' => 'Invalid email or password (min. 10 characters)'], 400);
        }
        // Hash outside the lock so it is held only briefly.
        $userId = $this->insertSingleUser($credentials['email'], Password::hash($credentials['password']));
        if ($userId === null) {
            return Json::write($response, ['message' => 'Setup already completed'], 403);
        }
        $this->setupCode->discard();
        $token = $this->sessions->createDeviceWithSession($userId, $credentials['deviceName'], $credentials['platform']);
        $this->lockout->recordSuccess(ClientIp::fromRequest($request));

        return $this->cookie->set(Json::write($response, ['email' => $credentials['email']]), $token);
    }

    private function login(Request $request, Response $response): Response
    {
        $ip = ClientIp::fromRequest($request);
        if (($locked = $this->lockout->isLockedOut($ip)) > 0) {
            return self::lockedOut($response, $locked);
        }
        $credentials = self::readCredentials(Body::json($request));
        if ($credentials === null) {
            return $this->authFailure($response, $ip, 'auth.login_failed', 401, 'Invalid email or password');
        }
        /** @var array{id: string, password_hash: string}|false $user */
        $user = Database::run($this->db->pdo(), 'SELECT id, password_hash FROM `user` WHERE email_lower = LOWER(?)', [$credentials['email']])->fetch();
        if ($user === false) {
            Password::dummyVerify($credentials['password']);

            return $this->authFailure($response, $ip, 'auth.login_failed', 401, 'Invalid email or password');
        }
        if (!Password::verify($credentials['password'], $user['password_hash'])) {
            return $this->authFailure($response, $ip, 'auth.login_failed', 401, 'Invalid email or password');
        }
        $this->lockout->recordSuccess($ip);
        // A login on a browser that still holds a valid session replaces it.
        $previous = ($old = SessionCookie::token($request)) !== null ? $this->sessions->resolve($old) : null;
        if ($previous !== null) {
            $this->sessions->delete($previous->sessionId);
        }
        $token = $this->sessions->createDeviceWithSession($user['id'], $credentials['deviceName'], $credentials['platform']);

        return $this->cookie->set(Json::write($response, ['email' => $credentials['email']]), $token);
    }

    private function password(Request $request, Response $response): Response
    {
        $ip = ClientIp::fromRequest($request);
        if (($locked = $this->lockout->isLockedOut($ip)) > 0) {
            return self::lockedOut($response, $locked);
        }
        $session = self::session($request);
        $body = Body::json($request);
        $current = Body::string($body, 'currentPassword');
        $new = Body::string($body, 'newPassword');
        $hash = Database::run($this->db->pdo(), 'SELECT password_hash FROM `user` WHERE id = ?', [$session->userId])->fetchColumn();
        $currentOk = \is_string($hash) && $current !== '' && mb_strlen($current) <= 200 && Password::verify($current, $hash);
        if (!$currentOk) {
            return $this->authFailure($response, $ip, 'auth.password_change_failed', 403, 'Current password is incorrect');
        }
        $this->lockout->recordSuccess($ip);
        if (!Password::isAcceptable($new)) {
            return Json::write($response, ['message' => 'New password must have 10 to 200 characters'], 400);
        }
        $token = $this->sessions->changePasswordAndEndOtherSessions($session, Password::hash($new));

        return $this->cookie->set($response->withStatus(204), $token);
    }

    private function logout(Request $request, Response $response): Response
    {
        $this->sessions->delete(self::session($request)->sessionId);

        return $this->cookie->clear($response->withStatus(204));
    }

    private function devices(Request $request, Response $response): Response
    {
        $session = self::session($request);

        return Json::write($response, ['devices' => $this->sessions->listDevices($session->userId, $session->deviceId)]);
    }

    /** @param array<string, string> $args */
    private function revokeDevice(Request $request, Response $response, array $args): Response
    {
        $session = self::session($request);
        $id = $args['id'] ?? '';
        if ($id === $session->deviceId) {
            return Json::write($response, ['message' => 'Cannot revoke the current device; log out instead'], 409);
        }
        if (!Uuid::isValid(strtolower($id)) || !$this->sessions->revokeDevice($session->userId, strtolower($id))) {
            return Json::write($response, ['message' => 'Device not found'], 404);
        }

        return $response->withStatus(204);
    }

    private static function session(Request $request): Session
    {
        $session = $request->getAttribute('auth');
        if (!$session instanceof Session) {
            throw new \LogicException('route without RequireAuth');
        }

        return $session;
    }

    private static function lockedOut(Response $response, int $seconds): Response
    {
        $minutes = (int) ceil($seconds / 60);

        return Json::write($response, ['message' => "Too many failed attempts. Try again in {$minutes} minutes."], 429)
            ->withHeader('Retry-After', (string) $seconds);
    }

    /** Security event without email, password or IP (ASVS 7.1.3). */
    private function authFailure(Response $response, string $ip, string $event, int $status, string $message): Response
    {
        $lockedOut = $this->lockout->recordFail($ip);
        $this->logger->warn('authentication failed', ['event' => $event, 'lockedOut' => $lockedOut]);

        return Json::write($response, ['message' => $message], $status);
    }

    /**
     * @param array<mixed> $body
     *
     * @return array{email: string, password: string, deviceName: string, platform: string}|null
     */
    private static function readCredentials(array $body): ?array
    {
        $email = mb_strtolower(trim(Body::string($body, 'email')));
        $password = Body::string($body, 'password');
        if (preg_match(self::EMAIL_RE, $email) !== 1 || !Password::isAcceptable($password)) {
            return null;
        }
        $deviceName = mb_substr(trim(Body::string($body, 'deviceName') ?: 'Browser'), 0, 100);
        $platform = Body::string($body, 'platform');

        return [
            'email' => $email,
            'password' => $password,
            'deviceName' => $deviceName !== '' ? $deviceName : 'Browser',
            'platform' => \in_array($platform, self::PLATFORMS, true) ? $platform : 'desktop',
        ];
    }

    private function userExists(): bool
    {
        return Database::run($this->db->pdo(), 'SELECT EXISTS (SELECT 1 FROM `user`)')->fetchColumn() == 1;
    }

    /** Creates the single user unless one exists; check and insert under one lock. */
    private function insertSingleUser(string $email, string $passwordHash): ?string
    {
        $pdo = $this->db->pdo();
        if ((int) Database::run($pdo, 'SELECT GET_LOCK(?, 10)', [self::SETUP_LOCK])->fetchColumn() !== 1) {
            return null;
        }
        try {
            if ($this->userExists()) {
                return null;
            }
            $id = Uuid::v4();
            Database::run($pdo, 'INSERT INTO `user` (id, email, password_hash) VALUES (?, ?, ?)', [$id, $email, $passwordHash]);

            return $id;
        } finally {
            Database::run($pdo, 'SELECT RELEASE_LOCK(?)', [self::SETUP_LOCK]);
        }
    }
}
