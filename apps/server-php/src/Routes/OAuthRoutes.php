<?php

declare(strict_types=1);

namespace Fma\Routes;

use Fma\Auth\Session;
use Fma\Config;
use Fma\Crypto\Envelope;
use Fma\Db\Database;
use Fma\Db\Uuid;
use Fma\Http\Body;
use Fma\Http\Json;
use Fma\Http\Middleware\RequireAuth;
use Fma\Jobs\JobQueue;
use Fma\Log\Logger;
use Fma\Mail\ConnectionTester;
use Fma\Mail\HostConfig;
use Fma\Mail\TransportPolicy;
use Fma\OAuth\AccountTokens;
use Fma\OAuth\OAuthException;
use Fma\OAuth\OAuthFlow;
use Fma\OAuth\Provider;
use Fma\OAuth\TokenClient;
use Fma\OAuth\TokenSet;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\App;

/**
 * Sign-in with Google or Microsoft (#36, ADR-0011):
 *
 * - GET /api/oauth/providers: which providers this instance has configured.
 * - POST /api/oauth/{provider}/start {accountId?}: authorization URL (PKCE,
 *   single-use state for 10 minutes); with accountId the existing account
 *   signs in again (expired or revoked grant).
 * - GET /api/oauth/callback: the provider redirects the browser here. The
 *   session cookie is not sent (SameSite=Strict on a cross-site redirect), so
 *   the state row says whose sign-in it is. Exchanges the code, tests IMAP
 *   and SMTP with XOAUTH2 like any new account, stores the account (or the
 *   new tokens) and redirects to the PWA with ?oauth=connected|error.
 *
 * Tokens are stored only encrypted in credential_enc; logs carry account ids
 * and error codes, never tokens, codes or addresses.
 */
final class OAuthRoutes
{
    private const STATE_TTL_SECONDS = 600;
    /** Error reasons the PWA can show (?oauth=error&reason=...). */
    private const REASONS = ['state', 'denied', 'not_configured', 'provider', 'network', 'no_refresh_token', 'no_email', 'invalid_grant', 'imap', 'smtp', 'wrong_account', 'limit'];

    public function __construct(
        private readonly Database $db,
        private readonly Config $config,
        private readonly ConnectionTester $tester,
        private readonly JobQueue $jobs,
        private readonly Logger $logger,
        private readonly ?TokenClient $tokens = null,
    ) {}

    /** @param App<\Psr\Container\ContainerInterface|null> $app */
    public function register(App $app, RequireAuth $requireAuth): void
    {
        $app->get('/api/oauth/providers', $this->providers(...))->add($requireAuth);
        $app->post('/api/oauth/{provider}/start', $this->start(...))->add($requireAuth);
        $app->get('/api/oauth/callback', $this->callback(...));
    }

    private function flow(): OAuthFlow
    {
        return $this->tokens === null ? new OAuthFlow($this->config) : new OAuthFlow($this->config, $this->tokens);
    }

    private function providers(Request $request, Response $response): Response
    {
        return Json::write($response, [
            'providers' => Provider::availability($this->config),
            'redirectUri' => $this->flow()->redirectUri(),
        ]);
    }

    /** @param array<string, string> $args */
    private function start(Request $request, Response $response, array $args): Response
    {
        $id = $args['provider'] ?? '';
        if (!\in_array($id, Provider::IDS, true)) {
            return Json::write($response, ['message' => 'Unbekannter Anbieter.'], 404);
        }
        $provider = Provider::fromConfig($this->config, $id);
        if ($provider === null) {
            return Json::write($response, ['message' => 'Die Anmeldung über diesen Anbieter ist auf dem Server nicht eingerichtet.', 'code' => 'NOT_CONFIGURED'], 409);
        }
        $redirectUri = $this->flow()->redirectUri();
        if ($redirectUri === null) {
            return Json::write($response, ['message' => 'Die öffentliche Adresse des Servers (PUBLIC_URL) ist nicht eingerichtet.', 'code' => 'NO_PUBLIC_URL'], 409);
        }

        $body = Body::json($request);
        $accountId = $body['accountId'] ?? null;
        $userId = self::session($request)->userId;
        $pdo = $this->db->pdo();
        $loginHint = null;
        if ($accountId !== null) {
            if (!\is_string($accountId) || !Uuid::isValid(strtolower($accountId))) {
                return Json::write($response, ['message' => 'Konto nicht gefunden.'], 404);
            }
            $accountId = strtolower($accountId);
            $email = Database::run(
                $pdo,
                "SELECT email_address FROM mail_account WHERE id = ? AND user_id = ? AND credential_kind = 'oauth2' AND oauth_provider = ?",
                [$accountId, $userId, $id],
            )->fetchColumn();
            if ($email === false) {
                return Json::write($response, ['message' => 'Konto nicht gefunden.'], 404);
            }
            $loginHint = (string) $email;
        }

        Database::run($pdo, 'DELETE FROM oauth_state WHERE created_at < UTC_TIMESTAMP(6) - INTERVAL ? SECOND', [self::STATE_TTL_SECONDS]);
        $state = OAuthFlow::base64Url(random_bytes(32));
        Database::run(
            $pdo,
            'INSERT INTO oauth_state (state_hash, user_id, provider, account_id) VALUES (?, ?, ?, ?)',
            [hash('sha256', $state, true), $userId, $id, $accountId],
        );

        return Json::write($response, ['url' => $this->flow()->authorizationUrl($provider, $state, $redirectUri, $loginHint)]);
    }

    private function callback(Request $request, Response $response): Response
    {
        $query = $request->getQueryParams();
        $state = $query['state'] ?? null;
        if (!\is_string($state) || $state === '' || \strlen($state) > 200) {
            return self::redirect($response, 'error', 'state');
        }
        $pdo = $this->db->pdo();
        $hash = hash('sha256', $state, true);
        /** @var array{user_id: string, provider: string, account_id: ?string}|false $pending */
        $pending = Database::run(
            $pdo,
            'SELECT user_id, provider, account_id FROM oauth_state WHERE state_hash = ? AND created_at >= UTC_TIMESTAMP(6) - INTERVAL ? SECOND',
            [$hash, self::STATE_TTL_SECONDS],
        )->fetch();
        // Single use, whatever happens next.
        Database::run($pdo, 'DELETE FROM oauth_state WHERE state_hash = ?', [$hash]);
        if ($pending === false) {
            return self::redirect($response, 'error', 'state');
        }
        $code = $query['code'] ?? null;
        if (isset($query['error']) || !\is_string($code) || $code === '') {
            return self::redirect($response, 'error', 'denied');
        }
        $provider = Provider::fromConfig($this->config, $pending['provider']);
        $redirectUri = $this->flow()->redirectUri();
        if ($provider === null || $redirectUri === null) {
            return self::redirect($response, 'error', 'not_configured');
        }

        try {
            $tokens = $this->flow()->exchangeCode($provider, $code, $state, $redirectUri);
        } catch (OAuthException $e) {
            $this->logger->warn('oauth code exchange failed', ['provider' => $provider->id, 'errorCode' => $e->errorCode]);

            return self::redirect($response, 'error', $e->errorCode);
        }
        $email = (string) $tokens->email;
        $imap = new HostConfig($provider->imapHost, $provider->imapPort, TransportPolicy::isSecurePort($provider->imapPort), $email, '', $tokens->accessToken);
        $smtp = new HostConfig($provider->smtpHost, $provider->smtpPort, TransportPolicy::isSecurePort($provider->smtpPort), $email, '', $tokens->accessToken);
        $imapResult = $this->tester->testImap($imap);
        if (!$imapResult->ok) {
            return self::redirect($response, 'error', 'imap', $imapResult->code);
        }
        $smtpResult = $this->tester->testSmtp($smtp);
        if (!$smtpResult->ok) {
            return self::redirect($response, 'error', 'smtp', $smtpResult->code);
        }

        // Signing in again: the requested account, or an OAuth account of this user with the same address.
        $existing = $pending['account_id'] ?? Database::run(
            $pdo,
            "SELECT id FROM mail_account WHERE user_id = ? AND credential_kind = 'oauth2' AND oauth_provider = ? AND LOWER(email_address) = ? LIMIT 1",
            [$pending['user_id'], $provider->id, $email],
        )->fetchColumn();
        if (\is_string($existing)) {
            return $this->renew($response, $pending['user_id'], $existing, $provider, $email, $tokens, $imapResult->capabilities);
        }

        $count = (int) Database::run($pdo, 'SELECT COUNT(*) FROM mail_account WHERE user_id = ?', [$pending['user_id']])->fetchColumn();
        if ($count >= AccountRoutes::MAX_ACCOUNTS) {
            return self::redirect($response, 'error', 'limit');
        }
        $credentials = AccountTokens::credentials($provider->id, $email, $tokens);
        $accountId = AccountRoutes::insertAccount(
            $pdo,
            $this->config,
            $this->jobs,
            $pending['user_id'],
            $email,
            $email,
            $imap,
            $smtp,
            $imapResult->capabilities,
            null,
            static fn(string $dek, string $id): string => AccountTokens::encrypt($dek, $id, $credentials),
            ['kind' => 'oauth2', 'provider' => $provider->id],
        );
        $this->logger->info('oauth account connected', ['accountId' => $accountId, 'provider' => $provider->id]);

        return self::redirect($response, 'connected', null, null, $accountId);
    }

    /** @param list<string> $capabilities */
    private function renew(Response $response, string $userId, string $accountId, Provider $provider, string $email, TokenSet $tokens, array $capabilities): Response
    {
        $pdo = $this->db->pdo();
        /** @var array{email_address: string, wrapped_dek: string}|false $account */
        $account = Database::run(
            $pdo,
            "SELECT email_address, wrapped_dek FROM mail_account WHERE id = ? AND user_id = ? AND credential_kind = 'oauth2' AND oauth_provider = ?",
            [$accountId, $userId, $provider->id],
        )->fetch();
        if ($account === false) {
            return self::redirect($response, 'error', 'state');
        }
        // The grant must belong to the same mailbox.
        if (mb_strtolower($account['email_address']) !== $email) {
            return self::redirect($response, 'error', 'wrong_account');
        }
        $dek = Envelope::unwrapAccountKey($this->config->get('MASTER_KEY'), $account['wrapped_dek']);
        Database::run(
            $pdo,
            "UPDATE mail_account SET credential_enc = ?, capabilities = ?, status = 'ok', error_count = 0, next_retry_at = NULL, last_error_code = NULL WHERE id = ?",
            [AccountTokens::encrypt($dek, $accountId, AccountTokens::credentials($provider->id, $email, $tokens)), json_encode($capabilities, JSON_THROW_ON_ERROR), $accountId],
        );
        $this->jobs->enqueue('folder_sync', $accountId);
        $this->logger->info('oauth account renewed', ['accountId' => $accountId, 'provider' => $provider->id]);

        return self::redirect($response, 'connected', null, null, $accountId);
    }

    private static function redirect(Response $response, string $result, ?string $reason = null, ?string $code = null, ?string $accountId = null): Response
    {
        $params = ['oauth' => $result];
        if ($reason !== null) {
            $params['reason'] = \in_array($reason, self::REASONS, true) ? $reason : 'provider';
        }
        if ($code !== null && preg_match('/^[A-Z_]{1,40}$/', $code) === 1) {
            $params['code'] = $code;
        }
        if ($accountId !== null) {
            $params['account'] = $accountId;
        }

        return $response->withStatus(303)->withHeader('Location', '/?' . http_build_query($params))->withHeader('Cache-Control', 'no-store');
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
