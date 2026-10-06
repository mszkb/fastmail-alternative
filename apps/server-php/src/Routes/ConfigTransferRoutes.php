<?php

declare(strict_types=1);

namespace Fma\Routes;

use Fma\Auth\Session;
use Fma\Config;
use Fma\Crypto\Envelope;
use Fma\Db\Database;
use Fma\Db\Uuid;
use Fma\Http\Body;
use Fma\Http\Input;
use Fma\Http\Json;
use Fma\Http\Middleware\RequireAuth;
use Fma\Log\Logger;
use Fma\Mail\TransportPolicy;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\App;
use Slim\Exception\HttpException;

/**
 * Configuration export/import like apps/api/src/mail/config-transfer.ts
 * (roadmap 4.7, docs/operations/migration.md).
 *
 * - GET /api/export/config: accounts (name, address, IMAP/SMTP host, port,
 *   user name), identities with signatures, manual folder mappings and
 *   settings as versioned JSON. Passwords, OAuth tokens, DEKs and mail
 *   content are NEVER exported; only the user names are read from the
 *   credential blob.
 * - POST /api/import/config: recreates the accounts in one transaction:
 *   fresh DEK, credential blob with the user names and EMPTY passwords,
 *   status `auth_error` / CREDENTIALS_REQUIRED, so no job runs until the
 *   password is entered. Accounts whose address exists are skipped.
 *
 * @phpstan-type ImportAccount array{displayName: string, emailAddress: string, sortOrder: int, credentialKind: 'oauth2'|'password', syncSince: ?string, imap: array{host: string, port: int, user: string}, smtp: array{host: string, port: int, user: string}, identities: list<array{name: string, emailAddress: string, signature: ?string, isDefault: bool}>, folderRoles: array<string, array{path: string, delimiter: ?string}>}
 */
final class ConfigTransferRoutes
{
    public const FORMAT = 'fma-config';
    /** Bump on incompatible changes; the import accepts versions <= current. */
    public const VERSION = 1;
    public const FOLDER_ROLES = ['sent', 'drafts', 'trash', 'archive', 'junk'];
    public const IMPORT_BODY_LIMIT_BYTES = 2 * 1024 * 1024;
    private const MAX_ACCOUNTS = AccountRoutes::MAX_ACCOUNTS;
    private const EMAIL_RE = '/^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+\z/u';
    private const HOST_RE = '/^[a-z0-9.-]{1,253}\z|^\[[0-9a-f:.]+\]\z/i';

    public function __construct(
        private readonly Database $db,
        private readonly Config $config,
        private readonly Logger $logger,
    ) {}

    /** @param App<\Psr\Container\ContainerInterface|null> $app */
    public function register(App $app, RequireAuth $requireAuth): void
    {
        $app->get('/api/export/config', $this->export(...))->add($requireAuth);
        $app->post('/api/import/config', $this->import(...))->add($requireAuth);
    }

    private function export(Request $request, Response $response): Response
    {
        $userId = self::session($request)->userId;
        $pdo = $this->db->pdo();
        /** @var list<array{id: string, display_name: string, email_address: string, sort_order: int|string, credential_kind: string, sync_since: ?string, imap_host: string, imap_port: int|string, smtp_host: string, smtp_port: int|string, wrapped_dek: string, credential_enc: string}> $accounts */
        $accounts = Database::run(
            $pdo,
            'SELECT id, display_name, email_address, sort_order, credential_kind, sync_since,
                    imap_host, imap_port, smtp_host, smtp_port, wrapped_dek, credential_enc
             FROM mail_account WHERE user_id = ?
             ORDER BY sort_order, created_at',
            [$userId],
        )->fetchAll();
        /** @var list<array{account_id: string, name: string, email_address: string, signature: ?string, is_default: int|string}> $identities */
        $identities = Database::run(
            $pdo,
            'SELECT i.account_id, i.name, i.email_address, i.signature, ' . IdentityRoutes::IDENTITY_IS_DEFAULT . ' AS is_default
             FROM identity i JOIN mail_account a ON a.id = i.account_id
             WHERE a.user_id = ?
             ORDER BY is_default DESC, i.email_address',
            [$userId],
        )->fetchAll();
        /** @var list<array{account_id: string, path: string, delimiter: ?string, special_use_override: string}> $folders */
        $folders = Database::run(
            $pdo,
            'SELECT f.account_id, f.path, f.delimiter, f.special_use_override
             FROM folder f JOIN mail_account a ON a.id = f.account_id
             WHERE a.user_id = ? AND f.special_use_override IS NOT NULL',
            [$userId],
        )->fetchAll();

        $exportedAt = (new \DateTimeImmutable('now', new \DateTimeZone('UTC')))->format('Y-m-d\TH:i:s.v\Z');
        $body = [
            'format' => self::FORMAT,
            'version' => self::VERSION,
            'exportedAt' => $exportedAt,
            'accounts' => array_map(function (array $row) use ($identities, $folders): array {
                $users = $this->userNames($row);
                $folderRoles = [];
                foreach ($folders as $folder) {
                    if ($folder['account_id'] !== $row['id'] || !\in_array($folder['special_use_override'], self::FOLDER_ROLES, true)) {
                        continue;
                    }
                    $folderRoles[$folder['special_use_override']] = ['path' => $folder['path'], 'delimiter' => $folder['delimiter']];
                }

                return [
                    'displayName' => $row['display_name'],
                    'emailAddress' => $row['email_address'],
                    'sortOrder' => (int) $row['sort_order'],
                    'credentialKind' => $row['credential_kind'] === 'oauth2' ? 'oauth2' : 'password',
                    'syncSince' => $row['sync_since'] !== null ? self::iso($row['sync_since']) : null,
                    'imap' => ['host' => $row['imap_host'], 'port' => (int) $row['imap_port'], 'user' => $users['imapUser']],
                    'smtp' => ['host' => $row['smtp_host'], 'port' => (int) $row['smtp_port'], 'user' => $users['smtpUser']],
                    'identities' => array_values(array_map(
                        static fn(array $identity): array => [
                            'name' => $identity['name'],
                            'emailAddress' => $identity['email_address'],
                            'signature' => $identity['signature'],
                            'isDefault' => (bool) $identity['is_default'],
                        ],
                        array_filter($identities, static fn(array $identity): bool => $identity['account_id'] === $row['id']),
                    )),
                    'folderRoles' => (object) $folderRoles,
                ];
            }, $accounts),
            'settings' => new \stdClass(),
        ];
        $date = substr($exportedAt, 0, 10);
        $response->getBody()->write(json_encode($body, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR));

        return $response
            ->withHeader('Content-Disposition', "attachment; filename=\"fma-config-{$date}.json\"")
            ->withHeader('Cache-Control', 'no-store')
            ->withHeader('Content-Type', 'application/json; charset=utf-8');
    }

    private function import(Request $request, Response $response): Response
    {
        $raw = (string) $request->getBody();
        if (\strlen($raw) > self::IMPORT_BODY_LIMIT_BYTES) {
            throw new HttpException($request, 'Payload Too Large', 413);
        }
        $decoded = trim($raw) === '' ? null : self::decode($request, $raw);
        $parsed = $this->parseConfigImport($decoded);
        if (isset($parsed['error'])) {
            return Json::write($response, ['message' => $parsed['error']], 400);
        }
        $accounts = $parsed['accounts'];
        $userId = self::session($request)->userId;
        $masterKey = Envelope::loadMasterKey($this->config->get('MASTER_KEY'));
        $keyId = $this->config->get('MASTER_KEY_ID', 'v1');
        $result = ['imported' => [], 'skipped' => []];

        $pdo = $this->db->pdo();
        $pdo->beginTransaction();
        try {
            // Serializes concurrent imports of the same user (account limit).
            Database::run($pdo, 'SELECT 1 FROM `user` WHERE id = ? FOR UPDATE', [$userId]);
            $known = array_flip(array_map(
                'strval',
                Database::run($pdo, 'SELECT LOWER(email_address) FROM mail_account WHERE user_id = ?', [$userId])->fetchAll(\PDO::FETCH_COLUMN),
            ));
            $count = \count($known);

            foreach ($accounts as $account) {
                $email = $account['emailAddress'];
                if (isset($known[$email])) {
                    $result['skipped'][] = $email;
                    continue;
                }
                if ($count >= self::MAX_ACCOUNTS) {
                    $pdo->rollBack();

                    return Json::write($response, ['message' => 'Maximale Anzahl an Konten erreicht.'], 409);
                }
                $known[$email] = true;
                ++$count;

                $accountId = Uuid::v4();
                $dek = Envelope::generateDataKey();
                // Only the user names survive the move; passwords must be re-entered.
                $credentialEnc = Envelope::encryptField(
                    $dek,
                    json_encode(
                        ['imapUser' => $account['imap']['user'], 'imapPassword' => '', 'smtpUser' => $account['smtp']['user'], 'smtpPassword' => ''],
                        JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR,
                    ),
                    Envelope::credentialAad($accountId),
                );
                Database::run(
                    $pdo,
                    "INSERT INTO mail_account
                       (id, user_id, display_name, email_address, sort_order, imap_host, imap_port,
                        smtp_host, smtp_port, wrapped_dek, key_id, credential_kind, sync_since,
                        credential_enc, status, last_error_code)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'auth_error', 'CREDENTIALS_REQUIRED')",
                    [
                        $accountId, $userId, $account['displayName'], $email, $account['sortOrder'],
                        $account['imap']['host'], $account['imap']['port'], $account['smtp']['host'], $account['smtp']['port'],
                        Envelope::wrapDataKey($masterKey, $dek, $keyId), $keyId, $account['credentialKind'],
                        self::toDatetime($account['syncSince']), $credentialEnc,
                    ],
                );

                // The account address always has an identity (data model).
                $identities = $account['identities'];
                $hasOwn = false;
                $hasDefault = false;
                foreach ($identities as $identity) {
                    $hasOwn = $hasOwn || $identity['emailAddress'] === $email;
                    $hasDefault = $hasDefault || $identity['isDefault'];
                }
                if (!$hasOwn) {
                    array_unshift($identities, ['name' => $account['displayName'], 'emailAddress' => $email, 'signature' => null, 'isDefault' => !$hasDefault]);
                }
                $defaultId = null;
                foreach ($identities as $identity) {
                    $identityId = Uuid::v4();
                    Database::run(
                        $pdo,
                        'INSERT INTO identity (id, account_id, name, email_address, signature) VALUES (?, ?, ?, ?, ?)',
                        [$identityId, $accountId, $identity['name'], $identity['emailAddress'], $identity['signature']],
                    );
                    if ($identity['isDefault'] && $defaultId === null) {
                        $defaultId = $identityId;
                    }
                }
                if ($defaultId !== null) {
                    Database::run($pdo, 'UPDATE mail_account SET default_identity_id = ? WHERE id = ?', [$defaultId, $accountId]);
                }

                foreach (self::FOLDER_ROLES as $role) {
                    $folder = $account['folderRoles'][$role] ?? null;
                    if ($folder === null) {
                        continue;
                    }
                    Database::run(
                        $pdo,
                        'INSERT INTO folder (id, account_id, path, delimiter, special_use, special_use_override)
                         VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE id = id',
                        [Uuid::v4(), $accountId, $folder['path'], $folder['delimiter'], $role, $role],
                    );
                }
                $result['imported'][] = $email;
            }
            $pdo->commit();
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
        $this->logger->info('configuration imported', ['imported' => \count($result['imported']), 'skipped' => \count($result['skipped'])]);

        return Json::write($response, $result);
    }

    /** Invalid JSON answers 400 like the body parser (Body::json). */
    private static function decode(Request $request, string $raw): mixed
    {
        try {
            return json_decode($raw, true, 64, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            throw new \Slim\Exception\HttpBadRequestException($request);
        }
    }

    /**
     * Reads only the user names from the credential blob; passwords are dropped here.
     *
     * @param array{id: string, wrapped_dek: string, credential_enc: string} $row
     *
     * @return array{imapUser: string, smtpUser: string}
     */
    private function userNames(array $row): array
    {
        try {
            $dek = Envelope::unwrapAccountKey($this->config->get('MASTER_KEY'), $row['wrapped_dek']);
            $stored = json_decode(Envelope::decryptField($dek, $row['credential_enc'], Envelope::credentialAad($row['id'])), true, 4, JSON_THROW_ON_ERROR);
            $stored = \is_array($stored) ? $stored : [];
            $imapUser = Body::string($stored, 'imapUser');
            $smtpUser = Body::string($stored, 'smtpUser');

            return ['imapUser' => $imapUser, 'smtpUser' => $smtpUser !== '' ? $smtpUser : $imapUser];
        } catch (\Throwable) {
            return ['imapUser' => '', 'smtpUser' => ''];
        }
    }

    // ---- import validation ------------------------------------------------

    /**
     * Validates a whole export file; error messages are German, without file content.
     *
     * @return array{error: string}|array{accounts: list<ImportAccount>}
     */
    public function parseConfigImport(mixed $body): array
    {
        $input = \is_array($body) ? $body : [];
        if (($input['format'] ?? null) !== self::FORMAT) {
            return ['error' => 'Keine Konfigurationsdatei dieser App.'];
        }
        $version = Input::integer($input['version'] ?? null);
        if ($version === null || $version < 1 || $version > self::VERSION) {
            return ['error' => 'Die Datei stammt aus einer neueren Version und kann nicht importiert werden.'];
        }
        $list = $input['accounts'] ?? null;
        if (!\is_array($list) || !array_is_list($list) || \count($list) > self::MAX_ACCOUNTS) {
            return ['error' => 'Ungültige Kontenliste.'];
        }
        $accounts = [];
        foreach ($list as $index => $raw) {
            $account = $this->parseAccount($raw, $index);
            if (isset($account['error'])) {
                return ['error' => $account['error']];
            }
            $accounts[] = $account;
        }

        return ['accounts' => $accounts];
    }

    /** @return ImportAccount|array{error: string} */
    private function parseAccount(mixed $value, int $index): array
    {
        $label = 'Konto ' . ($index + 1);
        $input = self::object($value);
        $emailAddress = self::str($input['emailAddress'] ?? null, 254);
        $emailAddress = $emailAddress !== null ? mb_strtolower($emailAddress) : null;
        if ($emailAddress === null || $emailAddress === '' || preg_match(self::EMAIL_RE, $emailAddress) !== 1) {
            return ['error' => "{$label}: ungültige E-Mail-Adresse."];
        }
        $imap = $this->parseHost($input['imap'] ?? null, 'imap', "{$label} (IMAP)");
        if (isset($imap['error'])) {
            return $imap;
        }
        if ($imap['user'] === '') {
            return ['error' => "{$label} (IMAP): Benutzername fehlt."];
        }
        $smtp = $this->parseHost($input['smtp'] ?? null, 'smtp', "{$label} (SMTP)");
        if (isset($smtp['error'])) {
            return $smtp;
        }

        $rawIdentities = \is_array($input['identities'] ?? null) && array_is_list($input['identities']) ? $input['identities'] : [];
        if (\count($rawIdentities) > IdentityRoutes::MAX_IDENTITIES_PER_ACCOUNT) {
            return ['error' => "{$label}: zu viele Identitäten."];
        }
        $identities = [];
        $seen = [];
        foreach ($rawIdentities as $raw) {
            $identity = self::parseIdentity($raw);
            if ($identity === null) {
                return ['error' => "{$label}: ungültige Identität."];
            }
            if (isset($seen[$identity['emailAddress']])) {
                continue;
            }
            $seen[$identity['emailAddress']] = true;
            $identities[] = $identity;
        }

        $folderRoles = [];
        $rawRoles = $input['folderRoles'] ?? null;
        if ($rawRoles !== null && (!\is_array($rawRoles) || (array_is_list($rawRoles) && $rawRoles !== []))) {
            return ['error' => "{$label}: ungültige Ordnerzuordnung."];
        }
        foreach ($rawRoles ?? [] as $role => $raw) {
            $entry = self::object($raw);
            $path = self::str($entry['path'] ?? null, 1000);
            $delimiter = \is_string($entry['delimiter'] ?? null) ? self::jsSlice($entry['delimiter'], 4) : null;
            // VARCHAR(700) in MySQL: longer paths cannot be stored (Node: 1000).
            if (!\in_array($role, self::FOLDER_ROLES, true) || $path === null || $path === '' || mb_strtoupper($path) === 'INBOX' || mb_strlen($path) > 700) {
                return ['error' => "{$label}: ungültige Ordnerzuordnung."];
            }
            $folderRoles[$role] = ['path' => $path, 'delimiter' => $delimiter !== null && $delimiter !== '' ? $delimiter : null];
        }

        $syncSince = \is_string($input['syncSince'] ?? null) ? self::parseDate($input['syncSince']) : null;
        $sortOrder = Input::integer($input['sortOrder'] ?? null);
        $displayName = self::str($input['displayName'] ?? null, 100);

        return [
            'displayName' => preg_replace('/[\r\n\t]+/', ' ', $displayName !== null && $displayName !== '' ? $displayName : $emailAddress) ?? $emailAddress,
            'emailAddress' => $emailAddress,
            'sortOrder' => $sortOrder === null ? 0 : max(-1_000_000, min(1_000_000, $sortOrder)),
            'credentialKind' => ($input['credentialKind'] ?? null) === 'oauth2' ? 'oauth2' : 'password',
            'syncSince' => $syncSince,
            'imap' => $imap,
            'smtp' => ['host' => $smtp['host'], 'port' => $smtp['port'], 'user' => $smtp['user'] !== '' ? $smtp['user'] : $imap['user']],
            'identities' => $identities,
            'folderRoles' => $folderRoles,
        ];
    }

    /**
     * @param 'imap'|'smtp' $protocol
     *
     * @return array{host: string, port: int, user: string}|array{error: string}
     */
    private function parseHost(mixed $value, string $protocol, string $label): array
    {
        $input = self::object($value);
        $host = self::str($input['host'] ?? null, 253);
        $host = $host !== null ? strtolower($host) : null;
        $port = Input::integer($input['port'] ?? null);
        $port = $port !== null && $port >= 1 && $port <= 65535 ? $port : null;
        $user = self::str($input['user'] ?? '', 320);
        if ($host === null || $host === '' || preg_match(self::HOST_RE, $host) !== 1 || $port === null || $user === null) {
            return ['error' => "{$label}: Host, Port oder Benutzer ungültig."];
        }
        if (!TransportPolicy::fromConfig($this->config)->isAllowedPort($protocol, $port)) {
            return ['error' => "{$label}: Port {$port} ist nicht erlaubt (MAIL_EXTRA_PORTS)."];
        }

        return ['host' => $host, 'port' => $port, 'user' => $user];
    }

    /** @return array{name: string, emailAddress: string, signature: ?string, isDefault: bool}|null */
    private static function parseIdentity(mixed $value): ?array
    {
        $input = self::object($value);
        $emailAddress = self::str($input['emailAddress'] ?? null, 254);
        $emailAddress = $emailAddress !== null ? mb_strtolower($emailAddress) : null;
        $name = self::str($input['name'] ?? '', IdentityRoutes::MAX_IDENTITY_NAME_LENGTH);
        $signature = $input['signature'] ?? null;
        if ($signature !== null) {
            if (!\is_string($signature) || self::jsLength($signature) > IdentityRoutes::MAX_SIGNATURE_LENGTH) {
                return null;
            }
            $signature = preg_replace('/[' . Input::WS . ']+\z/u', '', preg_replace('/\r\n?/', "\n", $signature) ?? $signature) ?? $signature;
            $signature = $signature === '' ? null : $signature;
        }
        if ($emailAddress === null || $emailAddress === '' || preg_match(self::EMAIL_RE, $emailAddress) !== 1 || $name === null) {
            return null;
        }

        return [
            'name' => preg_replace('/[\r\n\t]+/', ' ', $name) ?? $name,
            'emailAddress' => $emailAddress,
            'signature' => $signature,
            'isDefault' => ($input['isDefault'] ?? null) === true,
        ];
    }

    /** Trimmed string of at most `max` UTF-16 units, else null (like `str` in Node). */
    private static function str(mixed $value, int $max): ?string
    {
        if (!\is_string($value)) {
            return null;
        }
        $trimmed = Input::trim($value);

        return self::jsLength($trimmed) <= $max ? $trimmed : null;
    }

    /** @return array<mixed> JSON object as array; anything else is empty like `(value ?? {})` */
    private static function object(mixed $value): array
    {
        return \is_array($value) ? $value : [];
    }

    /** Date.parse + toISOString for the usual ISO formats; null when unparseable. */
    private static function parseDate(string $value): ?string
    {
        $value = trim($value);
        if ($value === '' || preg_match('/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?\z/', $value) !== 1) {
            return null;
        }
        try {
            // Date-only forms are UTC in JavaScript, so is everything without an offset here.
            $date = new \DateTimeImmutable($value, new \DateTimeZone('UTC'));
        } catch (\Exception) {
            return null;
        }
        $errors = \DateTimeImmutable::getLastErrors();
        if ($errors !== false && ($errors['warning_count'] > 0 || $errors['error_count'] > 0)) {
            return null;
        }

        return $date->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d\TH:i:s.v\Z');
    }

    /** ISO string (`...T...Z`) -> DATETIME(6) in UTC. */
    private static function toDatetime(?string $iso): ?string
    {
        return $iso === null ? null : (new \DateTimeImmutable($iso))->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d H:i:s.u');
    }

    /** DATETIME(6) (UTC) -> toISOString() form. */
    private static function iso(string $datetime): string
    {
        return (new \DateTimeImmutable($datetime, new \DateTimeZone('UTC')))->format('Y-m-d\TH:i:s.v\Z');
    }

    /** String length in UTF-16 code units, like JavaScript's `.length`. */
    private static function jsLength(string $value): int
    {
        return intdiv(\strlen((string) mb_convert_encoding($value, 'UTF-16LE', 'UTF-8')), 2);
    }

    /** First `max` UTF-16 units (`.slice(0, max)`; a split surrogate pair is dropped). */
    private static function jsSlice(string $value, int $max): string
    {
        $utf16 = substr((string) mb_convert_encoding($value, 'UTF-16LE', 'UTF-8'), 0, $max * 2);

        return (string) mb_convert_encoding($utf16, 'UTF-8', 'UTF-16LE');
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
