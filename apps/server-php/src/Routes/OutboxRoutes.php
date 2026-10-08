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
use Fma\Http\Json;
use Fma\Http\Middleware\RequireAuth;
use Fma\Jobs\JobQueue;
use Fma\Log\Logger;
use Fma\Mail\Compose;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\App;

/**
 * Sending API (roadmap 2.7):
 * POST /api/outbox stores the message encrypted with the account DEK and
 * enqueues send_message in the same transaction (Message-ID generated
 * once here); idempotent with `clientId`; `draftId` deletes the draft it
 * was written in; `attachmentIds` binds uploads (missing ones: 410
 * ATTACHMENT_MISSING). GET /api/outbox/{id}, GET /api/accounts/{id}/outbox
 * report status; POST /api/outbox/{id}/retry re-queues a failed message.
 *
 * Ownership via mail_account.user_id; foreign or unknown ids answer 404.
 * Decrypted content is never logged.
 */
final class OutboxRoutes
{
    private const LIST_LIMIT = 100;
    private const OUTBOX_COLUMNS = 'o.id, o.account_id, o.identity_id, o.status, o.content_enc,
        o.message_id_header, o.attempts, o.last_error_code, o.sent_copy, o.created_at, o.sent_at, a.wrapped_dek';

    public function __construct(
        private readonly Database $db,
        private readonly Config $config,
        private readonly JobQueue $jobs,
        private readonly Logger $logger,
    ) {}

    /** @param App<\Psr\Container\ContainerInterface|null> $app */
    public function register(App $app, RequireAuth $requireAuth): void
    {
        $app->post('/api/outbox', $this->send(...))->add($requireAuth);
        $app->get('/api/outbox/{id}', $this->get(...))->add($requireAuth);
        $app->get('/api/accounts/{id}/outbox', $this->list(...))->add($requireAuth);
        $app->post('/api/outbox/{id}/retry', $this->retry(...))->add($requireAuth);
    }

    /**
     * @return list<array{name: string, address: string}>|null
     */
    private static function parsePeople(mixed $value): ?array
    {
        if ($value === null) {
            return [];
        }
        if (!\is_array($value) || !array_is_list($value)) {
            return null;
        }
        $people = [];
        foreach ($value as $entry) {
            $raw = \is_string($entry) ? ['address' => $entry] : (\is_array($entry) ? $entry : []);
            if (!\is_string($raw['address'] ?? null)) {
                return null;
            }
            if (\array_key_exists('name', $raw) && $raw['name'] !== null && !\is_string($raw['name'])) {
                return null;
            }
            $address = trim($raw['address']);
            if (!Compose::isValidEmailAddress($address)) {
                return null;
            }
            $name = Compose::singleLine(\is_string($raw['name'] ?? null) ? $raw['name'] : '');
            if (Compose::jsLength($name) > Compose::MAX_NAME_LENGTH) {
                return null;
            }
            $people[] = ['name' => $name, 'address' => $address];
        }

        return $people;
    }

    /**
     * Validates the request; returns a German error message on failure.
     *
     * @param array<mixed> $input
     *
     * @return array{accountId: string, identityId: ?string, to: list<array{name: string, address: string}>, cc: list<array{name: string, address: string}>, bcc: list<array{name: string, address: string}>, subject: string, text: string, inReplyTo: ?string, references: list<string>, clientId: ?string, draftId: ?string, attachmentIds: list<string>}|string
     */
    public static function parseSendRequest(array $input): array|string
    {
        if (!Compose::isUuid($input['accountId'] ?? null)) {
            return 'Ungültiges Konto.';
        }
        foreach (['identityId' => 'Ungültige Absenderidentität.'] as $key => $message) {
            if (isset($input[$key]) && !Compose::isUuid($input[$key])) {
                return $message;
            }
        }
        $to = self::parsePeople($input['to'] ?? null);
        $cc = self::parsePeople($input['cc'] ?? null);
        $bcc = self::parsePeople($input['bcc'] ?? null);
        if ($to === null || $cc === null || $bcc === null) {
            return 'Ungültige Empfängeradresse.';
        }
        $total = \count($to) + \count($cc) + \count($bcc);
        if ($total === 0) {
            return 'Mindestens ein Empfänger ist erforderlich.';
        }
        if ($total > Compose::MAX_RECIPIENTS) {
            return 'Höchstens ' . Compose::MAX_RECIPIENTS . ' Empfänger sind erlaubt.';
        }
        if (!\is_string($input['subject'] ?? null)) {
            return 'Ungültiger Betreff.';
        }
        $subject = Compose::singleLine($input['subject']);
        if (Compose::jsLength($subject) > Compose::MAX_SUBJECT_LENGTH) {
            return 'Der Betreff ist zu lang.';
        }
        if (!\is_string($input['text'] ?? null)) {
            return 'Ungültiger Nachrichtentext.';
        }
        if (Compose::jsLength($input['text']) > Compose::MAX_TEXT_LENGTH) {
            return 'Der Nachrichtentext ist zu lang.';
        }
        $inReplyTo = $input['inReplyTo'] ?? null;
        if ($inReplyTo !== null && !Compose::isValidMessageId($inReplyTo)) {
            return 'Ungültiger In-Reply-To-Header.';
        }
        $references = $input['references'] ?? [];
        if (!\is_array($references) || !array_is_list($references) || \count($references) > Compose::MAX_REFERENCES
            || array_filter($references, static fn(mixed $r): bool => !Compose::isValidMessageId($r)) !== []) {
            return 'Ungültiger References-Header.';
        }
        if (isset($input['clientId']) && !Compose::isUuid($input['clientId'])) {
            return 'Ungültige Client-ID.';
        }
        if (isset($input['draftId']) && !Compose::isUuid($input['draftId'])) {
            return 'Ungültige Entwurfs-ID.';
        }
        $attachmentIds = $input['attachmentIds'] ?? [];
        if (!\is_array($attachmentIds) || !array_is_list($attachmentIds)
            || array_filter($attachmentIds, static fn(mixed $id): bool => !Compose::isUuid($id)) !== []) {
            return 'Ungültige Anhänge.';
        }
        if (\count($attachmentIds) > Compose::MAX_ATTACHMENT_COUNT) {
            return 'Höchstens ' . Compose::MAX_ATTACHMENT_COUNT . ' Anhänge sind erlaubt.';
        }
        /** @var list<string> $references */
        /** @var list<string> $attachmentIds */
        /** @var string $accountId */
        $accountId = $input['accountId'];

        return [
            'accountId' => strtolower($accountId),
            'identityId' => \is_string($input['identityId'] ?? null) ? strtolower($input['identityId']) : null,
            'to' => $to,
            'cc' => $cc,
            'bcc' => $bcc,
            'subject' => $subject,
            'text' => $input['text'],
            'inReplyTo' => \is_string($inReplyTo) ? $inReplyTo : null,
            'references' => $references,
            'clientId' => \is_string($input['clientId'] ?? null) ? strtolower($input['clientId']) : null,
            'draftId' => \is_string($input['draftId'] ?? null) ? strtolower($input['draftId']) : null,
            'attachmentIds' => array_values(array_unique(array_map('strtolower', $attachmentIds))),
        ];
    }

    private function send(Request $request, Response $response): Response
    {
        $raw = (string) $request->getBody();
        $input = Body::json($request);
        if (trim($raw) === '' || array_is_list($input) && $input !== []) {
            return Json::write($response, ['message' => 'Ungültige Anfrage.'], 400);
        }
        $parsed = self::parseSendRequest($input);
        if (\is_string($parsed)) {
            return Json::write($response, ['message' => $parsed], 400);
        }
        $userId = self::session($request)->userId;
        $pdo = $this->db->pdo();
        /** @var array{id: string, display_name: string, email_address: string, wrapped_dek: string}|false $account */
        $account = Database::run(
            $pdo,
            'SELECT id, display_name, email_address, wrapped_dek FROM mail_account WHERE id = ? AND user_id = ?',
            [$parsed['accountId'], $userId],
        )->fetch();
        if ($account === false) {
            return Json::write($response, ['message' => 'Konto nicht gefunden.'], 404);
        }
        if ($parsed['clientId'] !== null) {
            $existing = $this->loadByClientId($account['id'], $parsed['clientId']);
            if ($existing !== null) {
                return Json::write($response, $this->toOutboxMessage($existing), 200);
            }
        }

        /** @var array{id: string, name: string, email_address: string}|false $identity */
        $identity = $parsed['identityId'] !== null
            ? Database::run($pdo, 'SELECT id, name, email_address FROM identity WHERE account_id = ? AND id = ?', [$account['id'], $parsed['identityId']])->fetch()
            : Database::run(
                $pdo,
                'SELECT i.id, i.name, i.email_address FROM identity i JOIN mail_account a ON a.id = i.account_id
                 WHERE i.account_id = ? ORDER BY ' . IdentityRoutes::IDENTITY_IS_DEFAULT . ' DESC, i.email_address LIMIT 1',
                [$account['id']],
            )->fetch();
        if ($parsed['identityId'] !== null && $identity === false) {
            return Json::write($response, ['message' => 'Absenderidentität nicht gefunden.'], 404);
        }
        $from = $identity !== false
            ? ['name' => Compose::singleLine($identity['name']), 'address' => $identity['email_address']]
            : ['name' => Compose::singleLine($account['display_name']), 'address' => $account['email_address']];

        $id = Uuid::v4();
        $at = strrpos($from['address'], '@');
        $domain = $at === false ? '' : substr($from['address'], $at + 1);
        $messageId = '<' . Uuid::v4() . '@' . ($domain !== '' ? $domain : 'localhost') . '>';
        $content = [
            'from' => $from,
            'to' => $parsed['to'],
            'cc' => $parsed['cc'],
            'bcc' => $parsed['bcc'],
            'subject' => $parsed['subject'],
            'text' => $parsed['text'],
        ];
        $dek = Envelope::unwrapAccountKey($this->config->get('MASTER_KEY'), $account['wrapped_dek']);
        $contentEnc = Envelope::encryptField($dek, json_encode($content, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), Envelope::outboxContentAad($id));

        $pdo->beginTransaction();
        try {
            Database::run(
                $pdo,
                "INSERT INTO outbox_message
                   (id, account_id, identity_id, status, content_enc, message_id_header, in_reply_to, `references`, client_id, attachment_count)
                 VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)",
                [
                    $id, $account['id'], $identity !== false ? $identity['id'] : null, $contentEnc, $messageId,
                    $parsed['inReplyTo'], json_encode($parsed['references'], JSON_THROW_ON_ERROR), $parsed['clientId'],
                    \count($parsed['attachmentIds']),
                ],
            );
            if ($parsed['attachmentIds'] !== []) {
                $ids = $parsed['attachmentIds'];
                $in = implode(', ', array_fill(0, \count($ids), '?'));
                // Each upload belongs to one message only; uploads kept with the draft move to the message.
                Database::run(
                    $pdo,
                    "UPDATE attachment_upload SET outbox_id = ?, draft_id = NULL
                     WHERE account_id = ? AND outbox_id IS NULL AND id IN ({$in})",
                    [$id, $account['id'], ...$ids],
                );
                /** @var list<array{id: string, size_bytes: int|string}> $attached */
                $attached = Database::run($pdo, 'SELECT id, size_bytes FROM attachment_upload WHERE outbox_id = ?', [$id])->fetchAll();
                $total = array_sum(array_map(static fn(array $row): int => (int) $row['size_bytes'], $attached));
                $maxTotal = Compose::attachmentLimits($this->config)['maxTotalBytes'];
                if (\count($attached) !== \count($ids) || $total > $maxTotal) {
                    $pdo->rollBack();
                    if (\count($attached) !== \count($ids)) {
                        $found = array_column($attached, 'id');

                        return Json::write($response, [
                            'code' => Compose::ATTACHMENT_MISSING,
                            'message' => Compose::ATTACHMENT_MISSING_MESSAGE,
                            'missingIds' => array_values(array_filter($ids, static fn(string $a): bool => !\in_array($a, $found, true))),
                        ], 410);
                    }

                    return Json::write($response, ['message' => 'Die Anhänge sind zusammen zu groß (höchstens ' . Compose::formatByteSize($maxTotal) . ').'], 413);
                }
            }
            $this->jobs->enqueue('send_message', $account['id'], ['outboxId' => $id]);
            if ($parsed['draftId'] !== null) {
                // The draft is done: delete it, the worker removes its IMAP copy.
                $deleted = Database::run(
                    $pdo,
                    'UPDATE draft SET deleted_at = UTC_TIMESTAMP(6), content_enc = NULL, updated_at = UTC_TIMESTAMP(6)
                     WHERE id = ? AND account_id = ? AND deleted_at IS NULL',
                    [$parsed['draftId'], $account['id']],
                )->rowCount();
                if ($deleted > 0) {
                    $this->jobs->enqueueDraftSync($account['id'], $parsed['draftId']);
                }
            }
            $pdo->commit();
        } catch (\PDOException $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            // Concurrent repeat with the same client id: answer with the winner.
            $existing = $parsed['clientId'] !== null && ($e->errorInfo[1] ?? null) === 1062
                ? $this->loadByClientId($account['id'], $parsed['clientId'])
                : null;
            if ($existing === null) {
                throw $e;
            }

            return Json::write($response, $this->toOutboxMessage($existing), 200);
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }

        $row = $this->loadOwned($id, $userId) ?? throw new \RuntimeException('outbox row missing');

        return Json::write($response, $this->toOutboxMessage($row), 201);
    }

    /** @param array<string, string> $args */
    private function get(Request $request, Response $response, array $args): Response
    {
        $row = $this->loadOwned($args['id'] ?? '', self::session($request)->userId);
        if ($row === null) {
            return Json::write($response, ['message' => 'Nachricht nicht gefunden.'], 404);
        }

        return Json::write($response, $this->toOutboxMessage($row));
    }

    /** @param array<string, string> $args */
    private function list(Request $request, Response $response, array $args): Response
    {
        $accountId = strtolower($args['id'] ?? '');
        $pdo = $this->db->pdo();
        $owned = Compose::isUuid($accountId)
            && Database::run($pdo, 'SELECT 1 FROM mail_account WHERE id = ? AND user_id = ?', [$accountId, self::session($request)->userId])->fetchColumn() !== false;
        if (!$owned) {
            return Json::write($response, ['message' => 'Konto nicht gefunden.'], 404);
        }
        /** @var list<array<string, mixed>> $rows */
        $rows = Database::run(
            $pdo,
            'SELECT ' . self::OUTBOX_COLUMNS . "
             FROM outbox_message o JOIN mail_account a ON a.id = o.account_id
             WHERE o.account_id = ? AND o.status IN ('queued', 'sending', 'failed')
             ORDER BY o.created_at DESC, o.id
             LIMIT " . self::LIST_LIMIT,
            [$accountId],
        )->fetchAll();

        return Json::write($response, ['messages' => array_map($this->toOutboxMessage(...), $rows)]);
    }

    /** @param array<string, string> $args */
    private function retry(Request $request, Response $response, array $args): Response
    {
        $userId = self::session($request)->userId;
        $row = $this->loadOwned($args['id'] ?? '', $userId);
        if ($row === null) {
            return Json::write($response, ['message' => 'Nachricht nicht gefunden.'], 404);
        }
        $pdo = $this->db->pdo();
        $pdo->beginTransaction();
        try {
            // Only failed messages, and only once (concurrent retries race on the status).
            $changed = Database::run(
                $pdo,
                "UPDATE outbox_message SET status = 'queued', last_error_code = NULL, updated_at = UTC_TIMESTAMP(6)
                 WHERE id = ? AND status = 'failed'",
                [$row['id']],
            )->rowCount();
            if ($changed === 0) {
                $pdo->rollBack();

                return Json::write($response, ['message' => 'Nur fehlgeschlagene Nachrichten können erneut gesendet werden.'], 409);
            }
            $this->jobs->enqueue('send_message', (string) $row['account_id'], ['outboxId' => $row['id']]);
            $pdo->commit();
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
        $updated = $this->loadOwned((string) $row['id'], $userId) ?? throw new \RuntimeException('outbox row missing');

        return Json::write($response, $this->toOutboxMessage($updated));
    }

    /** @return array<string, mixed>|null */
    private function loadByClientId(string $accountId, string $clientId): ?array
    {
        /** @var array<string, mixed>|false $row */
        $row = Database::run(
            $this->db->pdo(),
            'SELECT ' . self::OUTBOX_COLUMNS . ' FROM outbox_message o JOIN mail_account a ON a.id = o.account_id
             WHERE o.account_id = ? AND o.client_id = ?',
            [$accountId, $clientId],
        )->fetch();

        return $row === false ? null : $row;
    }

    /** @return array<string, mixed>|null */
    private function loadOwned(string $id, string $userId): ?array
    {
        if (!Compose::isUuid($id)) {
            return null;
        }
        /** @var array<string, mixed>|false $row */
        $row = Database::run(
            $this->db->pdo(),
            'SELECT ' . self::OUTBOX_COLUMNS . ' FROM outbox_message o JOIN mail_account a ON a.id = o.account_id
             WHERE o.id = ? AND a.user_id = ?',
            [strtolower($id), $userId],
        )->fetch();

        return $row === false ? null : $row;
    }

    /**
     * @param array<string, mixed> $row
     *
     * @return array<string, mixed>
     */
    private function toOutboxMessage(array $row): array
    {
        $id = (string) $row['id'];
        $content = null;
        if (\is_string($row['content_enc'])) {
            try {
                $dek = Envelope::unwrapAccountKey($this->config->get('MASTER_KEY'), (string) $row['wrapped_dek']);
                $decoded = json_decode(Envelope::decryptField($dek, $row['content_enc'], Envelope::outboxContentAad($id)), true, 64, JSON_THROW_ON_ERROR);
                $content = \is_array($decoded) ? $decoded : null;
            } catch (\Throwable) {
                $this->logger->warn('outbox content could not be decrypted', ['outboxId' => $id]);
            }
        }
        $code = \is_string($row['last_error_code']) ? $row['last_error_code'] : null;
        $error = null;
        if ($code !== null && $code !== '') {
            $known = \array_key_exists($code, Compose::OUTBOX_ERROR_MESSAGES) ? $code : 'UNKNOWN';
            $error = ['code' => $known, 'message' => Compose::OUTBOX_ERROR_MESSAGES[$known]];
        }

        return [
            'id' => $id,
            'accountId' => $row['account_id'],
            'identityId' => $row['identity_id'],
            'status' => $row['status'],
            'subject' => $content['subject'] ?? null,
            'from' => $content['from'] ?? null,
            'to' => $content['to'] ?? [],
            'cc' => $content['cc'] ?? [],
            'bcc' => $content['bcc'] ?? [],
            'messageId' => $row['message_id_header'],
            'attempts' => (int) $row['attempts'],
            'error' => $error,
            'sentCopy' => $row['sent_copy'],
            'createdAt' => Sessions::iso((string) $row['created_at']),
            'sentAt' => Sessions::iso(\is_string($row['sent_at']) ? $row['sent_at'] : null),
        ];
    }

    private static function session(Request $request): Session
    {
        $session = $request->getAttribute('auth');
        if (!$session instanceof Session) {
            throw new \LogicException('route requires RequireAuth');
        }

        return $session;
    }
}
