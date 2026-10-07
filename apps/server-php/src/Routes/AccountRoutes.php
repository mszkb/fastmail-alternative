<?php

declare(strict_types=1);

namespace Fma\Routes;

use Fma\Auth\Session;
use Fma\Auth\Sessions;
use Fma\Config;
use Fma\Crypto\Envelope;
use Fma\Db\Database;
use Fma\Db\Uuid;
use Fma\Http\Body;
use Fma\Http\Input;
use Fma\Http\Json;
use Fma\Http\Middleware\RequireAuth;
use Fma\Jobs\JobQueue;
use Fma\Mail\ConnectionTester;
use Fma\Mail\HostConfig;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\App;

/**
 * /api/accounts like apps/api/src/mail/accounts.ts (roadmap 2.1, 3.1):
 * create with connection test, list, edit, delete.
 *
 * - Credentials are encrypted with the account DEK and never leave the
 *   server: responses use an explicit column select.
 * - The DEK is wrapped with the master key; deleting the account deletes
 *   it (crypto-shredding), the worker removes the stored files
 *   (`account_cleanup` job).
 * - Editing connection data re-runs the connection test before anything is
 *   saved; empty user/password fields mean "unchanged".
 */
final class AccountRoutes
{
    public const MAX_ACCOUNTS = 20;
    private const EMAIL_RE = '/^[^\s@]+@[^\s@]+\.[^\s@]+\z/u';
    /** DNS hostname labels (letters, digits, inner hyphens), optional trailing dot. */
    private const HOSTNAME_RE = '/^(?=.{1,253}\z)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.?\z/';
    private const NOT_FOUND = 'Konto nicht gefunden.';

    /** Explicit column select: credential_enc and wrapped_dek must never leak. */
    private const PUBLIC_COLUMNS = 'id, display_name, email_address, imap_host, imap_port, smtp_host, smtp_port,
        status, last_error_code, next_retry_at, capabilities, sort_order, last_sync_at, sync_since';

    /** SQL: a folder/message sync of the account is queued (and eligible) or running (roadmap 4.5). */
    public const SYNCING_COLUMN = "EXISTS (
        SELECT 1 FROM job j
        WHERE j.account_id = mail_account.id
          AND j.type IN ('folder_sync', 'message_sync')
          AND (j.state = 'running' OR (
            j.state = 'queued' AND j.run_at <= UTC_TIMESTAMP(6)
            AND mail_account.status NOT IN ('disabled', 'auth_error')
            AND (mail_account.next_retry_at IS NULL OR mail_account.next_retry_at <= UTC_TIMESTAMP(6))
          ))
      ) AS syncing";

    public function __construct(
        private readonly Database $db,
        private readonly Config $config,
        private readonly ConnectionTester $tester,
        private readonly JobQueue $jobs,
    ) {}

    /** @param App<\Psr\Container\ContainerInterface|null> $app */
    public function register(App $app, RequireAuth $requireAuth): void
    {
        $app->get('/api/accounts', $this->list(...))->add($requireAuth);
        $app->post('/api/accounts', $this->create(...))->add($requireAuth);
        $app->patch('/api/accounts/{id}', $this->update(...))->add($requireAuth);
        $app->delete('/api/accounts/{id}', $this->delete(...))->add($requireAuth);
    }

    private function list(Request $request, Response $response): Response
    {
        // Unread count per account: INBOX only, computed from the synced locations like the folder counts.
        $rows = Database::run(
            $this->db->pdo(),
            'SELECT ' . self::PUBLIC_COLUMNS . ",
               (SELECT COUNT(*) FROM folder f
                JOIN message_location ml ON ml.folder_id = f.id
                WHERE f.account_id = mail_account.id AND f.special_use = 'inbox'
                  AND NOT EXISTS (SELECT 1 FROM message_flag mf WHERE mf.location_id = ml.id AND mf.flag = ?)) AS unread_count,
               " . self::SYNCING_COLUMN . '
             FROM mail_account WHERE user_id = ?
             ORDER BY sort_order, created_at',
            ['\Seen', self::session($request)->userId],
        )->fetchAll();

        return Json::write($response, ['accounts' => array_map(self::toPublicAccount(...), $rows)]);
    }

    private function create(Request $request, Response $response): Response
    {
        $parsed = self::parseCreateBody(Body::json($request));
        if ($parsed === null) {
            return Json::write($response, ['message' => 'Ungültige Kontodaten (E-Mail, Host, Port, Benutzer, Passwort, Sync-Zeitraum prüfen).'], 400);
        }
        $userId = self::session($request)->userId;
        $pdo = $this->db->pdo();

        // Sane upper bound of accounts per user.
        $count = (int) Database::run($pdo, 'SELECT COUNT(*) FROM mail_account WHERE user_id = ?', [$userId])->fetchColumn();
        if ($count >= self::MAX_ACCOUNTS) {
            return Json::write($response, ['message' => 'Maximale Anzahl an Konten erreicht.'], 409);
        }

        // Connection test FIRST: broken accounts are not persisted.
        $imapResult = $this->tester->testImap($parsed['imap']);
        if (!$imapResult->ok) {
            return Json::write($response, ['stage' => 'imap', 'test' => $imapResult->toArray()], 422);
        }
        $smtpResult = $this->tester->testSmtp($parsed['smtp']);
        if (!$smtpResult->ok) {
            return Json::write($response, ['stage' => 'smtp', 'test' => $smtpResult->toArray()], 422);
        }

        // Fresh DEK per account, wrapped with the master key; the id is known up front for the credential AAD.
        $masterKey = Envelope::loadMasterKey($this->config->get('MASTER_KEY'));
        $keyId = $this->config->get('MASTER_KEY_ID', 'v1');
        $accountId = Uuid::v4();
        $dek = Envelope::generateDataKey();
        $wrappedDek = Envelope::wrapDataKey($masterKey, $dek, $keyId);
        $credentialEnc = self::encryptCredentials($dek, $accountId, $parsed['imap'], $parsed['smtp']);

        $pdo->beginTransaction();
        try {
            Database::run(
                $pdo,
                "INSERT INTO mail_account
                   (id, user_id, display_name, email_address, imap_host, imap_port,
                    smtp_host, smtp_port, wrapped_dek, key_id, credential_enc, status, capabilities, sync_since)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok', ?, ?)",
                [
                    $accountId, $userId, $parsed['displayName'], $parsed['emailAddress'],
                    $parsed['imap']->host, $parsed['imap']->port, $parsed['smtp']->host, $parsed['smtp']->port,
                    $wrappedDek, $keyId, $credentialEnc,
                    json_encode($imapResult->capabilities, JSON_THROW_ON_ERROR), self::utcMidnight($parsed['syncSince']),
                ],
            );
            // Default identity from the account email address (data model, 3.6).
            $identityId = Uuid::v4();
            Database::run($pdo, 'INSERT INTO identity (id, account_id, name, email_address) VALUES (?, ?, ?, ?)', [$identityId, $accountId, $parsed['displayName'], $parsed['emailAddress']]);
            Database::run($pdo, 'UPDATE mail_account SET default_identity_id = ? WHERE id = ?', [$identityId, $accountId]);
            // Kick off the initial folder sync in the worker (roadmap 2.2).
            $this->jobs->enqueue('folder_sync', $accountId);
            $pdo->commit();
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }

        return Json::write($response, [
            'account' => $this->publicAccount($accountId),
            'test' => ['imap' => $imapResult->toArray(), 'smtp' => $smtpResult->toArray()],
        ], 201);
    }

    /** @param array<string, string> $args */
    private function update(Request $request, Response $response, array $args): Response
    {
        $accountId = strtolower($args['id'] ?? '');
        if (!Uuid::isValid($accountId)) {
            return Json::write($response, ['message' => self::NOT_FOUND], 404);
        }
        $update = self::isJsonObject($request) ? self::parseUpdateBody(Body::json($request)) : null;
        if ($update === null) {
            return Json::write($response, ['message' => 'Ungültige Kontodaten (Name, Host, Port, Benutzer, Passwort, Sync-Zeitraum prüfen).'], 400);
        }
        $pdo = $this->db->pdo();
        /** @var array{imap_host: string, imap_port: int, smtp_host: string, smtp_port: int, wrapped_dek: string, credential_enc: string}|false $current */
        $current = Database::run(
            $pdo,
            'SELECT imap_host, imap_port, smtp_host, smtp_port, wrapped_dek, credential_enc
             FROM mail_account WHERE id = ? AND user_id = ?',
            [$accountId, self::session($request)->userId],
        )->fetch();
        if ($current === false) {
            return Json::write($response, ['message' => self::NOT_FOUND], 404);
        }

        $sets = [];
        $values = [];
        if (\array_key_exists('displayName', $update)) {
            $sets[] = 'display_name = ?';
            $values[] = $update['displayName'];
        }
        if (\array_key_exists('sortOrder', $update)) {
            $sets[] = 'sort_order = ?';
            $values[] = $update['sortOrder'];
        }
        // Takes effect with the next message_sync; already stored older messages are kept.
        if (\array_key_exists('syncSince', $update)) {
            $sets[] = 'sync_since = ?';
            $values[] = self::utcMidnight($update['syncSince']);
        }

        $test = null;
        if (isset($update['imap']) || isset($update['smtp'])) {
            $dek = Envelope::unwrapAccountKey($this->config->get('MASTER_KEY'), $current['wrapped_dek']);
            $stored = json_decode(Envelope::decryptField($dek, $current['credential_enc'], Envelope::credentialAad($accountId)), true, 4, JSON_THROW_ON_ERROR);
            [$imap, $smtp] = self::mergeConnection($current, \is_array($stored) ? $stored : [], $update);

            // Connection test FIRST: nothing is saved when the new data fails.
            $imapResult = $this->tester->testImap($imap);
            if (!$imapResult->ok) {
                return Json::write($response, ['stage' => 'imap', 'test' => $imapResult->toArray()], 422);
            }
            $smtpResult = $this->tester->testSmtp($smtp);
            if (!$smtpResult->ok) {
                return Json::write($response, ['stage' => 'smtp', 'test' => $smtpResult->toArray()], 422);
            }
            $test = ['imap' => $imapResult->toArray(), 'smtp' => $smtpResult->toArray()];

            array_push($sets, 'imap_host = ?', 'imap_port = ?', 'smtp_host = ?', 'smtp_port = ?', 'credential_enc = ?', 'capabilities = ?');
            array_push(
                $values,
                $imap->host,
                $imap->port,
                $smtp->host,
                $smtp->port,
                self::encryptCredentials($dek, $accountId, $imap, $smtp),
                json_encode($imapResult->capabilities, JSON_THROW_ON_ERROR),
            );
            // Working credentials: clear the error state (roadmap 3.4).
            array_push($sets, "status = 'ok'", 'error_count = 0', 'next_retry_at = NULL', 'last_error_code = NULL');
        }

        if ($sets !== []) {
            Database::run($pdo, 'UPDATE mail_account SET ' . implode(', ', $sets) . ' WHERE id = ?', [...$values, $accountId]);
        }
        // Re-sync right away with the new connection data or sync limit.
        if ($test !== null || \array_key_exists('syncSince', $update)) {
            $this->jobs->enqueue('folder_sync', $accountId);
        }

        return Json::write($response, ['account' => $this->publicAccount($accountId)] + ($test !== null ? ['test' => $test] : []));
    }

    /** @param array<string, string> $args */
    private function delete(Request $request, Response $response, array $args): Response
    {
        $accountId = strtolower($args['id'] ?? '');
        if (!Uuid::isValid($accountId)) {
            return Json::write($response, ['message' => self::NOT_FOUND], 404);
        }
        $pdo = $this->db->pdo();
        $pdo->beginTransaction();
        try {
            // Cascades to identities, folders, messages, locations, bodies, threads, outbox and jobs.
            $deleted = Database::run($pdo, 'DELETE FROM mail_account WHERE id = ? AND user_id = ?', [$accountId, self::session($request)->userId])->rowCount();
            if ($deleted === 0) {
                $pdo->rollBack();

                return Json::write($response, ['message' => self::NOT_FOUND], 404);
            }
            // The id goes in the payload only: job.account_id would cascade-delete the job with the account.
            $this->jobs->enqueue('account_cleanup', null, ['accountId' => $accountId]);
            $pdo->commit();
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }

        // Crypto-shredding: the wrapped DEK row is gone, orphaned ciphertexts stay unreadable.
        return $response->withStatus(204);
    }

    /** @return array<string, mixed> */
    private function publicAccount(string $accountId): array
    {
        $row = Database::run($this->db->pdo(), 'SELECT ' . self::PUBLIC_COLUMNS . ' FROM mail_account WHERE id = ?', [$accountId])->fetch();
        if (!\is_array($row)) {
            throw new \RuntimeException('account row missing');
        }

        return self::toPublicAccount($row);
    }

    /**
     * Public account shape: never includes credentials or the DEK.
     *
     * @param array<string, mixed> $row
     *
     * @return array<string, mixed>
     */
    private static function toPublicAccount(array $row): array
    {
        $capabilities = json_decode((string) $row['capabilities'], true);
        $syncSince = $row['sync_since'];

        return [
            'id' => $row['id'],
            'displayName' => $row['display_name'],
            'emailAddress' => $row['email_address'],
            'imap' => ['host' => $row['imap_host'], 'port' => (int) $row['imap_port']],
            'smtp' => ['host' => $row['smtp_host'], 'port' => (int) $row['smtp_port']],
            'status' => $row['status'],
            'lastErrorCode' => $row['last_error_code'],
            'nextRetryAt' => Sessions::iso(\is_string($row['next_retry_at']) ? $row['next_retry_at'] : null),
            'capabilities' => \is_array($capabilities) ? array_values($capabilities) : [],
            'sortOrder' => (int) $row['sort_order'],
            'lastSyncAt' => Sessions::iso(\is_string($row['last_sync_at']) ? $row['last_sync_at'] : null),
            'syncSince' => \is_string($syncSince) ? substr($syncSince, 0, 10) : null,
            'unreadCount' => (int) ($row['unread_count'] ?? 0),
            'syncing' => (bool) ($row['syncing'] ?? false),
        ];
    }

    /** Credential blob, same JSON as Node: {imapUser, imapPassword, smtpUser, smtpPassword}. */
    private static function encryptCredentials(string $dek, string $accountId, HostConfig $imap, HostConfig $smtp): string
    {
        $json = json_encode(
            ['imapUser' => $imap->user, 'imapPassword' => $imap->password, 'smtpUser' => $smtp->user, 'smtpPassword' => $smtp->password],
            JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR,
        );

        return Envelope::encryptField($dek, $json, Envelope::credentialAad($accountId));
    }

    /**
     * @param array<mixed> $body
     *
     * @return array{displayName: string, emailAddress: string, syncSince: ?string, imap: HostConfig, smtp: HostConfig}|null
     */
    private static function parseCreateBody(array $body): ?array
    {
        // Check every field's runtime type so malformed input yields 400 instead of a 500.
        if (!self::isOptionalString($body, 'displayName') || !self::isOptionalString($body, 'emailAddress')) {
            return null;
        }
        $emailAddress = mb_strtolower(Input::trim(Body::string($body, 'emailAddress')));
        if (preg_match(self::EMAIL_RE, $emailAddress) !== 1) {
            return null;
        }
        $imap = $body['imap'] ?? null;
        $smtp = $body['smtp'] ?? null;
        if (!\is_array($imap) || !\is_array($smtp)) {
            return null;
        }
        $imapUser = $imap['user'] ?? null;
        $imapPassword = $imap['password'] ?? null;
        if (!self::isNonEmptyString($imap['host'] ?? null) || !self::isNonEmptyString($imapUser) || !self::isNonEmptyString($imapPassword)) {
            return null;
        }
        if (!self::isNonEmptyString($smtp['host'] ?? null) || !self::isOptionalString($smtp, 'user') || !self::isOptionalString($smtp, 'password')) {
            return null;
        }
        $imapPort = self::port($imap['port'] ?? null);
        $smtpPort = self::port($smtp['port'] ?? null);
        if ($imapPort === null || $smtpPort === null) {
            return null;
        }
        $imapHost = self::parseHostName($imap['host']);
        $smtpHost = self::parseHostName($smtp['host']);
        if ($imapHost === null || $smtpHost === null) {
            return null;
        }
        $syncSince = \array_key_exists('syncSince', $body) ? self::parseSyncSince($body['syncSince']) : null;
        if ($syncSince === false) {
            return null;
        }
        $displayName = mb_substr(Input::trim(Body::string($body, 'displayName')), 0, 100);
        // Empty strings count as "not provided" -> fall back to the IMAP credentials.
        $smtpUser = Input::trim(Body::string($smtp, 'user'));
        $smtpPassword = Body::string($smtp, 'password');

        return [
            'displayName' => $displayName !== '' ? $displayName : $emailAddress,
            'emailAddress' => $emailAddress,
            'syncSince' => $syncSince,
            'imap' => new HostConfig($imapHost, $imapPort, self::isSecurePort($imapPort), mb_substr(Input::trim($imapUser), 0, 320), $imapPassword),
            'smtp' => new HostConfig(
                $smtpHost,
                $smtpPort,
                self::isSecurePort($smtpPort),
                mb_substr(Input::trim($smtpUser !== '' ? $smtpUser : $imapUser), 0, 320),
                $smtpPassword !== '' ? $smtpPassword : $imapPassword,
            ),
        ];
    }

    /**
     * Validates a PATCH body. Every field is optional; empty user/password
     * strings mean "unchanged". Returns null for invalid input.
     *
     * @param array<mixed> $body
     *
     * @return array{displayName?: string, sortOrder?: int, syncSince?: ?string, imap?: array{host?: string, port?: int, user?: string, password?: string}, smtp?: array{host?: string, port?: int, user?: string, password?: string}}|null
     */
    private static function parseUpdateBody(array $body): ?array
    {
        $result = [];
        if (\array_key_exists('displayName', $body)) {
            if (!\is_string($body['displayName'])) {
                return null;
            }
            $name = mb_substr(Input::trim($body['displayName']), 0, 100);
            if ($name === '') {
                return null;
            }
            $result['displayName'] = $name;
        }
        if (\array_key_exists('sortOrder', $body)) {
            $order = Input::integer($body['sortOrder']);
            if ($order === null || abs($order) > 1_000_000) {
                return null;
            }
            $result['sortOrder'] = $order;
        }
        if (\array_key_exists('syncSince', $body)) {
            $since = self::parseSyncSince($body['syncSince']);
            if ($since === false) {
                return null;
            }
            $result['syncSince'] = $since;
        }
        foreach (['imap', 'smtp'] as $stage) {
            if (!\array_key_exists($stage, $body)) {
                continue;
            }
            $input = $body[$stage];
            if (!\is_array($input)) {
                return null;
            }
            $parsed = [];
            if (\array_key_exists('host', $input)) {
                $host = \is_string($input['host']) ? self::parseHostName($input['host']) : null;
                if ($host === null) {
                    return null;
                }
                $parsed['host'] = $host;
            }
            if (\array_key_exists('port', $input)) {
                $port = self::port($input['port']);
                if ($port === null) {
                    return null;
                }
                $parsed['port'] = $port;
            }
            if (isset($input['user'])) {
                if (!\is_string($input['user'])) {
                    return null;
                }
                $user = Input::trim($input['user']);
                if ($user !== '') {
                    $parsed['user'] = mb_substr($user, 0, 320);
                }
            }
            if (isset($input['password'])) {
                if (!\is_string($input['password'])) {
                    return null;
                }
                if ($input['password'] !== '') {
                    $parsed['password'] = $input['password'];
                }
            }
            if ($parsed !== []) {
                $result[$stage] = $parsed;
            }
        }

        return $result;
    }

    /**
     * Merges the stored connection data with an update. SMTP credentials that
     * were identical to the IMAP ones follow IMAP changes unless SMTP
     * credentials are given explicitly.
     *
     * @param array{imap_host: string, imap_port: int, smtp_host: string, smtp_port: int} $current
     * @param array<mixed> $stored
     * @param array{imap?: array{host?: string, port?: int, user?: string, password?: string}, smtp?: array{host?: string, port?: int, user?: string, password?: string}} $update
     *
     * @return array{HostConfig, HostConfig}
     */
    private static function mergeConnection(array $current, array $stored, array $update): array
    {
        $storedImapUser = Body::string($stored, 'imapUser');
        $storedImapPassword = Body::string($stored, 'imapPassword');
        $storedSmtpUser = Body::string($stored, 'smtpUser') ?: $storedImapUser;
        $storedSmtpPassword = Body::string($stored, 'smtpPassword') ?: $storedImapPassword;
        $smtpFollowsImap = $storedSmtpUser === $storedImapUser && $storedSmtpPassword === $storedImapPassword;

        $imapPort = $update['imap']['port'] ?? (int) $current['imap_port'];
        $imapUser = $update['imap']['user'] ?? $storedImapUser;
        $imapPassword = $update['imap']['password'] ?? $storedImapPassword;
        $smtpPort = $update['smtp']['port'] ?? (int) $current['smtp_port'];

        return [
            new HostConfig($update['imap']['host'] ?? $current['imap_host'], $imapPort, self::isSecurePort($imapPort), $imapUser, $imapPassword),
            new HostConfig(
                $update['smtp']['host'] ?? $current['smtp_host'],
                $smtpPort,
                self::isSecurePort($smtpPort),
                $update['smtp']['user'] ?? ($smtpFollowsImap ? $imapUser : $storedSmtpUser),
                $update['smtp']['password'] ?? ($smtpFollowsImap ? $imapPassword : $storedSmtpPassword),
            ),
        ];
    }

    /**
     * Normalized mail host, or null when it is neither a hostname nor an IP
     * literal (no URLs, ports, paths or spaces; ASVS 5.1.3).
     */
    private static function parseHostName(string $value): ?string
    {
        $host = mb_strtolower(Input::trim($value));

        return preg_match(self::HOSTNAME_RE, $host) === 1 || filter_var($host, FILTER_VALIDATE_IP) !== false ? $host : null;
    }

    /**
     * `syncSince` like parseSyncSince in packages/shared: null (no limit) or
     * a day `YYYY-MM-DD` between 1970-01-01 and tomorrow (UTC); false when
     * invalid.
     */
    private static function parseSyncSince(mixed $value): string|false|null
    {
        if ($value === null) {
            return null;
        }
        if (!\is_string($value) || preg_match('/^(\d{4})-(\d{2})-(\d{2})\z/', $value, $m) !== 1) {
            return false;
        }
        if (!checkdate((int) $m[2], (int) $m[3], (int) $m[1]) || (int) $m[1] < 1970) {
            return false;
        }
        $tomorrow = (new \DateTimeImmutable('now', new \DateTimeZone('UTC')))->modify('+1 day')->format('Y-m-d');

        return $value > $tomorrow ? false : $value;
    }

    /** UTC midnight of a `YYYY-MM-DD` day for the DATETIME column `sync_since`. */
    private static function utcMidnight(?string $day): ?string
    {
        return $day === null ? null : "{$day} 00:00:00";
    }

    private static function port(mixed $value): ?int
    {
        $port = Input::integer($value);

        return $port !== null && $port >= 1 && $port <= 65535 ? $port : null;
    }

    private static function isSecurePort(int $port): bool
    {
        return $port === 993 || $port === 465;
    }

    /** @param array<mixed> $body */
    private static function isOptionalString(array $body, string $key): bool
    {
        return !\array_key_exists($key, $body) || \is_string($body[$key]);
    }

    /** @phpstan-assert-if-true non-empty-string $value */
    private static function isNonEmptyString(mixed $value): bool
    {
        return \is_string($value) && $value !== '';
    }

    /** Node rejects a missing or non-object PATCH body (Body::json maps both to []). */
    private static function isJsonObject(Request $request): bool
    {
        $raw = ltrim((string) $request->getBody());

        return $raw !== '' && ($raw[0] === '{' || $raw[0] === '[');
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
