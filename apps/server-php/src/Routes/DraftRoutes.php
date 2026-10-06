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
use Fma\Mail\RawStorage;
use Fma\Mail\Uploads;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\App;

/**
 * Drafts API (roadmap 2.8), port of apps/api/src/mail/drafts.ts: PUT
 * creates or replaces a draft (client-generated id; `baseVersion` against
 * lost updates: 409 with the current draft unless `force`; a sent or
 * discarded draft answers 410), GET reads one or the account's list,
 * DELETE discards (idempotent), POST /api/messages/{id}/draft opens a
 * message of the IMAP Drafts folder for editing. `attachmentIds` keeps
 * uploads with the draft. Every change enqueues a coalesced draft_sync.
 *
 * Ownership via mail_account.user_id; unknown or foreign ids answer 404.
 * Decrypted content is never logged.
 */
final class DraftRoutes
{
    /** Delay of the IMAP upload after an autosave (coalesces bursts of saves). */
    public const DRAFT_UPLOAD_DELAY_SECONDS = 15;
    private const LIST_LIMIT = 200;
    private const GONE_MESSAGE = 'Der Entwurf wurde inzwischen gesendet oder verworfen.';
    /** Message-ID of an uploaded draft version: `<draft id>.<version>@domain`. */
    private const DRAFT_MESSAGE_ID_RE = '/^<([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.\d+@/i';
    private const DRAFT_SELECT = 'SELECT d.id, d.account_id, d.identity_id, d.content_enc, d.in_reply_to, d.`references`,
        d.version, d.created_at, d.updated_at, d.deleted_at, d.message_id_header, a.wrapped_dek
        FROM draft d JOIN mail_account a ON a.id = d.account_id';

    public function __construct(
        private readonly Database $db,
        private readonly Config $config,
        private readonly JobQueue $jobs,
        private readonly RawStorage $storage,
        private readonly Logger $logger,
    ) {}

    /** @param App<\Psr\Container\ContainerInterface|null> $app */
    public function register(App $app, RequireAuth $requireAuth): void
    {
        $app->put('/api/drafts/{id}', $this->save(...))->add($requireAuth);
        $app->get('/api/drafts/{id}', $this->get(...))->add($requireAuth);
        $app->get('/api/accounts/{id}/drafts', $this->list(...))->add($requireAuth);
        $app->delete('/api/drafts/{id}', $this->delete(...))->add($requireAuth);
        $app->post('/api/messages/{id}/draft', $this->openMessage(...))->add($requireAuth);
    }

    /**
     * Validates a save request; returns a German error message on failure.
     *
     * @param array<mixed> $input
     *
     * @return array{accountId: string, identityId: ?string, to: string, cc: string, bcc: string, subject: string, text: string, inReplyTo: ?string, references: list<string>, baseVersion: ?int, force: bool, attachmentIds: ?list<string>}|string
     */
    public static function parseDraftRequest(array $input): array|string
    {
        if (!Compose::isUuid($input['accountId'] ?? null)) {
            return 'Ungültiges Konto.';
        }
        $identityId = $input['identityId'] ?? null;
        if ($identityId !== null && !Compose::isUuid($identityId)) {
            return 'Ungültige Absenderidentität.';
        }
        $fields = [];
        foreach (['to', 'cc', 'bcc'] as $field) {
            $value = $input[$field] ?? '';
            if (!\is_string($value)) {
                return 'Ungültige Empfängerangabe.';
            }
            if (Compose::jsLength($value) > Compose::MAX_ADDRESS_FIELD_LENGTH) {
                return 'Zu viele Empfänger.';
            }
            $fields[$field] = $value;
        }
        if (!\is_string($input['subject'] ?? null)) {
            return 'Ungültiger Betreff.';
        }
        if (Compose::jsLength($input['subject']) > Compose::MAX_SUBJECT_LENGTH) {
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
        $baseVersion = $input['baseVersion'] ?? null;
        if (\is_float($baseVersion) && floor($baseVersion) === $baseVersion) {
            $baseVersion = (int) $baseVersion;
        }
        if ($baseVersion !== null && (!\is_int($baseVersion) || $baseVersion < 0)) {
            return 'Ungültige Version.';
        }
        if (\array_key_exists('force', $input) && $input['force'] !== null && !\is_bool($input['force'])) {
            return 'Ungültige Anfrage.';
        }
        $attachmentIds = $input['attachmentIds'] ?? null;
        if ($attachmentIds !== null && (!\is_array($attachmentIds) || !array_is_list($attachmentIds)
            || array_filter($attachmentIds, static fn(mixed $id): bool => !Compose::isUuid($id)) !== [])) {
            return 'Ungültige Anhänge.';
        }
        if ($attachmentIds !== null && \count($attachmentIds) > Compose::MAX_ATTACHMENT_COUNT) {
            return 'Höchstens ' . Compose::MAX_ATTACHMENT_COUNT . ' Anhänge sind erlaubt.';
        }
        /** @var list<string> $references */
        /** @var list<string>|null $attachmentIds */
        /** @var string $accountId */
        $accountId = $input['accountId'];

        return [
            'accountId' => strtolower($accountId),
            'identityId' => \is_string($identityId) ? strtolower($identityId) : null,
            'to' => $fields['to'],
            'cc' => $fields['cc'],
            'bcc' => $fields['bcc'],
            // No line breaks in the subject (it becomes a header of the IMAP copy).
            'subject' => (string) preg_replace('/[\r\n]+/', ' ', $input['subject']),
            'text' => $input['text'],
            'inReplyTo' => \is_string($inReplyTo) ? $inReplyTo : null,
            'references' => $references,
            'baseVersion' => $baseVersion,
            'force' => ($input['force'] ?? false) === true,
            'attachmentIds' => $attachmentIds === null ? null : array_values(array_unique(array_map('strtolower', $attachmentIds))),
        ];
    }

    /** @param array<string, string> $args */
    private function save(Request $request, Response $response, array $args): Response
    {
        $id = strtolower($args['id'] ?? '');
        if (!Compose::isUuid($id)) {
            return Json::write($response, ['message' => 'Entwurf nicht gefunden.'], 404);
        }
        $input = Body::json($request);
        if (trim((string) $request->getBody()) === '' || (array_is_list($input) && $input !== [])) {
            return Json::write($response, ['message' => 'Ungültige Anfrage.'], 400);
        }
        $parsed = self::parseDraftRequest($input);
        if (\is_string($parsed)) {
            return Json::write($response, ['message' => $parsed], 400);
        }
        $userId = self::session($request)->userId;
        $pdo = $this->db->pdo();
        $wrappedDek = $this->ownsAccount($parsed['accountId'], $userId);
        if ($wrappedDek === null) {
            return Json::write($response, ['message' => 'Konto nicht gefunden.'], 404);
        }
        if ($parsed['identityId'] !== null
            && Database::run($pdo, 'SELECT 1 FROM identity WHERE id = ? AND account_id = ?', [$parsed['identityId'], $parsed['accountId']])->fetchColumn() === false) {
            return Json::write($response, ['message' => 'Absenderidentität nicht gefunden.'], 404);
        }
        $dek = Envelope::unwrapAccountKey($this->config->get('MASTER_KEY'), $wrappedDek);
        $contentEnc = self::encryptContent($dek, $id, [
            'to' => $parsed['to'], 'cc' => $parsed['cc'], 'bcc' => $parsed['bcc'],
            'subject' => $parsed['subject'], 'text' => $parsed['text'],
        ]);
        $references = json_encode($parsed['references'], JSON_THROW_ON_ERROR);

        $created = false;
        $pdo->beginTransaction();
        try {
            // Only a save without baseVersion creates the draft (once sent or discarded, the row may be gone).
            if (($parsed['baseVersion'] ?? 0) === 0) {
                $created = Database::run(
                    $pdo,
                    'INSERT IGNORE INTO draft (id, account_id, identity_id, content_enc, in_reply_to, `references`) VALUES (?, ?, ?, ?, ?, ?)',
                    [$id, $parsed['accountId'], $parsed['identityId'], $contentEnc, $parsed['inReplyTo'], $references],
                )->rowCount() > 0;
            }
            if (!$created) {
                /** @var array{account_id: string, user_id: string, version: int|string, deleted_at: ?string}|false $existing */
                $existing = Database::run(
                    $pdo,
                    'SELECT d.account_id, a.user_id, d.version, d.deleted_at
                     FROM draft d JOIN mail_account a ON a.id = d.account_id WHERE d.id = ? FOR UPDATE',
                    [$id],
                )->fetch();
                if ($existing === false || ($existing['user_id'] === $userId && $existing['account_id'] === $parsed['accountId'] && $existing['deleted_at'] !== null)) {
                    $pdo->rollBack();

                    return Json::write($response, ['message' => self::GONE_MESSAGE], 410);
                }
                if ($existing['user_id'] !== $userId || $existing['account_id'] !== $parsed['accountId']) {
                    $pdo->rollBack();

                    return Json::write($response, ['message' => 'Entwurf nicht gefunden.'], 404);
                }
                if ($parsed['baseVersion'] !== null && $parsed['baseVersion'] !== (int) $existing['version'] && !$parsed['force']) {
                    $pdo->rollBack();
                    $current = $this->loadOwned($id, $userId) ?? throw new \RuntimeException('draft row missing');

                    return Json::write($response, [
                        'message' => 'Der Entwurf wurde inzwischen auf einem anderen Gerät geändert.',
                        'draft' => $this->toDraft($current),
                    ], 409);
                }
                Database::run(
                    $pdo,
                    'UPDATE draft SET identity_id = ?, content_enc = ?, in_reply_to = ?, `references` = ?,
                       version = version + 1, updated_at = UTC_TIMESTAMP(6) WHERE id = ?',
                    [$parsed['identityId'], $contentEnc, $parsed['inReplyTo'], $references, $id],
                );
            }
            if ($parsed['attachmentIds'] !== null) {
                $ids = $parsed['attachmentIds'];
                Uploads::lockAccount($pdo, $parsed['accountId']);
                // Released uploads fall back to the normal retention of the cleanup.
                if ($ids === []) {
                    Database::run($pdo, 'UPDATE attachment_upload SET draft_id = NULL WHERE draft_id = ?', [$id]);
                } else {
                    $in = implode(', ', array_fill(0, \count($ids), '?'));
                    Database::run($pdo, "UPDATE attachment_upload SET draft_id = NULL WHERE draft_id = ? AND id NOT IN ({$in})", [$id, ...$ids]);
                    // Unknown, foreign, sent or other drafts' uploads are ignored.
                    Database::run(
                        $pdo,
                        "UPDATE attachment_upload SET draft_id = ?
                         WHERE account_id = ? AND outbox_id IS NULL AND id IN ({$in}) AND (draft_id IS NULL OR draft_id = ?)",
                        [$id, $parsed['accountId'], ...$ids, $id],
                    );
                }
                $maxTotal = Compose::attachmentLimits($this->config)['maxTotalBytes'];
                $total = (int) Database::run($pdo, 'SELECT COALESCE(SUM(size_bytes), 0) FROM attachment_upload WHERE draft_id = ? AND outbox_id IS NULL', [$id])->fetchColumn();
                if ($total > $maxTotal) {
                    $pdo->rollBack();

                    return Json::write($response, ['message' => 'Die Anhänge sind zusammen zu groß (höchstens ' . Compose::formatByteSize($maxTotal) . ').'], 413);
                }
                if (Uploads::countDraftUploads($pdo, $parsed['accountId']) > Uploads::MAX_DRAFT_UPLOADS) {
                    $pdo->rollBack();

                    return Json::write($response, ['message' => 'Zu viele Anhänge in Entwürfen (höchstens ' . Uploads::MAX_DRAFT_UPLOADS . ' je Konto).'], 429);
                }
            }
            $this->jobs->enqueueDraftSync($parsed['accountId'], $id, self::DRAFT_UPLOAD_DELAY_SECONDS);
            $pdo->commit();
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
        $row = $this->loadOwned($id, $userId) ?? throw new \RuntimeException('draft row missing');

        return Json::write($response, $this->toDraft($row), $created ? 201 : 200);
    }

    /** @param array<string, string> $args */
    private function get(Request $request, Response $response, array $args): Response
    {
        $row = $this->loadOwned($args['id'] ?? '', self::session($request)->userId);
        if ($row === null) {
            return Json::write($response, ['message' => 'Entwurf nicht gefunden.'], 404);
        }

        return Json::write($response, $this->toDraft($row));
    }

    /** @param array<string, string> $args */
    private function list(Request $request, Response $response, array $args): Response
    {
        $accountId = strtolower($args['id'] ?? '');
        if ($this->ownsAccount($accountId, self::session($request)->userId) === null) {
            return Json::write($response, ['message' => 'Konto nicht gefunden.'], 404);
        }
        /** @var list<array<string, mixed>> $rows */
        $rows = Database::run(
            $this->db->pdo(),
            self::DRAFT_SELECT . ' WHERE d.account_id = ? AND d.deleted_at IS NULL ORDER BY d.updated_at DESC, d.id LIMIT ' . self::LIST_LIMIT,
            [$accountId],
        )->fetchAll();

        return Json::write($response, ['drafts' => array_map($this->toDraft(...), $rows)]);
    }

    /** @param array<string, string> $args */
    private function delete(Request $request, Response $response, array $args): Response
    {
        $id = strtolower($args['id'] ?? '');
        if (!Compose::isUuid($id)) {
            return Json::write($response, ['message' => 'Entwurf nicht gefunden.'], 404);
        }
        $pdo = $this->db->pdo();
        /** @var array{account_id: string, user_id: string}|false $row */
        $row = Database::run($pdo, 'SELECT d.account_id, a.user_id FROM draft d JOIN mail_account a ON a.id = d.account_id WHERE d.id = ?', [$id])->fetch();
        if ($row !== false && $row['user_id'] !== self::session($request)->userId) {
            return Json::write($response, ['message' => 'Entwurf nicht gefunden.'], 404);
        }
        // Unknown or already deleted: nothing to do (idempotent, offline replays).
        if ($row !== false) {
            $pdo->beginTransaction();
            try {
                $changed = Database::run(
                    $pdo,
                    'UPDATE draft SET deleted_at = UTC_TIMESTAMP(6), content_enc = NULL, updated_at = UTC_TIMESTAMP(6) WHERE id = ? AND deleted_at IS NULL',
                    [$id],
                )->rowCount();
                if ($changed > 0) {
                    // The uploads go now; the row after the IMAP cleanup.
                    Database::run($pdo, 'DELETE FROM attachment_upload WHERE draft_id = ? AND outbox_id IS NULL', [$id]);
                    $this->jobs->enqueueDraftSync($row['account_id'], $id);
                }
                $pdo->commit();
            } catch (\Throwable $e) {
                if ($pdo->inTransaction()) {
                    $pdo->rollBack();
                }
                throw $e;
            }
        }

        return $response->withStatus(204);
    }

    /** @param array<string, string> $args */
    private function openMessage(Request $request, Response $response, array $args): Response
    {
        $messageId = strtolower($args['id'] ?? '');
        $userId = self::session($request)->userId;
        if (!Compose::isUuid($messageId)) {
            return Json::write($response, ['message' => 'Nachricht nicht gefunden.'], 404);
        }
        $pdo = $this->db->pdo();
        $created = false;
        $hasAttachments = false;
        $dek = '';
        $accountId = '';
        $pdo->beginTransaction();
        try {
            // Locks the message: a double click resumes the same draft.
            /** @var array{account_id: string, wrapped_dek: string, message_id_header: string, in_reply_to: ?string, references: ?string, subject_enc: string, recipients_enc: string, text_plain_enc: ?string, has_attachments: int|string}|false $message */
            $message = Database::run(
                $pdo,
                'SELECT m.account_id, a.wrapped_dek, m.message_id_header, m.in_reply_to, m.`references`,
                        m.subject_enc, m.recipients_enc, mb.text_plain_enc, m.has_attachments
                 FROM message m JOIN mail_account a ON a.id = m.account_id
                 LEFT JOIN message_body mb ON mb.message_id = m.id
                 WHERE m.id = ? AND a.user_id = ? FOR UPDATE',
                [$messageId, $userId],
            )->fetch();
            if ($message === false) {
                $pdo->rollBack();

                return Json::write($response, ['message' => 'Nachricht nicht gefunden.'], 404);
            }
            $accountId = $message['account_id'];
            $hasAttachments = (bool) $message['has_attachments'];
            $ownId = preg_match(self::DRAFT_MESSAGE_ID_RE, $message['message_id_header'], $m) === 1 ? strtolower($m[1]) : '00000000-0000-0000-0000-000000000000';
            $existing = Database::run(
                $pdo,
                'SELECT id FROM draft WHERE account_id = ? AND deleted_at IS NULL AND (id = ? OR message_id_header = ?)
                 ORDER BY (id = ?) DESC LIMIT 1',
                [$accountId, $ownId, $message['message_id_header'], $ownId],
            )->fetchColumn();
            if ($existing !== false) {
                $draftId = (string) $existing;
            } else {
                if ($message['text_plain_enc'] === null) {
                    $pdo->rollBack();

                    return Json::write($response, ['message' => 'Der Inhalt dieses Entwurfs ist noch nicht synchronisiert.'], 409);
                }
                $dek = Envelope::unwrapAccountKey($this->config->get('MASTER_KEY'), $message['wrapped_dek']);
                $recipients = json_decode(Envelope::decryptField($dek, $message['recipients_enc'], Envelope::messageFieldAad('recipients', $messageId)), true);
                $recipients = \is_array($recipients) ? $recipients : [];
                $draftId = Uuid::v4();
                $created = true;
                /** @var array{folder_id: string, uidvalidity: int|string, uid: int|string}|false $location */
                $location = Database::run(
                    $pdo,
                    "SELECT ml.folder_id, ml.uidvalidity, ml.uid FROM message_location ml JOIN folder f ON f.id = ml.folder_id
                     WHERE ml.message_id = ? AND ml.uid > 0
                     ORDER BY (COALESCE(f.special_use, '') = 'drafts') DESC LIMIT 1",
                    [$messageId],
                )->fetch();
                // Not uploaded until edited (imap_version = version); keep_source while attachments are copied.
                Database::run(
                    $pdo,
                    'INSERT INTO draft (id, account_id, content_enc, in_reply_to, `references`, version, imap_version,
                       message_id_header, source_folder_id, source_uidvalidity, source_uid, keep_source)
                     VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?)',
                    [
                        $draftId, $accountId,
                        self::encryptContent($dek, $draftId, [
                            'to' => Compose::formatAddressList(self::toPeople($recipients['to'] ?? null)),
                            'cc' => Compose::formatAddressList(self::toPeople($recipients['cc'] ?? null)),
                            'bcc' => '',
                            'subject' => Envelope::decryptField($dek, $message['subject_enc'], Envelope::messageFieldAad('subject', $messageId)),
                            'text' => Envelope::decryptField($dek, $message['text_plain_enc'], Envelope::messageFieldAad('text', $messageId)),
                        ]),
                        $message['in_reply_to'], $message['references'] ?? '[]', $message['message_id_header'],
                        $location !== false ? $location['folder_id'] : null,
                        $location !== false ? $location['uidvalidity'] : null,
                        $location !== false ? $location['uid'] : null,
                        $hasAttachments ? 1 : 0,
                    ],
                );
            }
            $pdo->commit();
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
        $skipped = 0;
        if ($created) {
            // Keep the other client's attachments; when not all could be copied
            // the original stays in the Drafts folder (keep_source).
            $complete = !$hasAttachments;
            try {
                $raw = $this->loadRaw($messageId, $userId);
                if ($raw !== null) {
                    $skipped = Uploads::copyFromRaw($pdo, $this->config, $raw, $accountId, $dek, $draftId)['skipped'];
                    $complete = $skipped === 0;
                }
            } catch (\Throwable) {
                $complete = false;
                $this->logger->warn('draft attachments could not be copied', ['draftId' => $draftId]);
            }
            if (!$complete) {
                $skipped = max($skipped, 1);
                $this->logger->warn('draft attachments skipped', ['draftId' => $draftId, 'skipped' => $skipped]);
            }
            if ($complete === $hasAttachments) {
                Database::run($pdo, 'UPDATE draft SET keep_source = ? WHERE id = ?', [$complete ? 0 : 1, $draftId]);
            }
        }
        $row = $this->loadOwned($draftId, $userId) ?? throw new \RuntimeException('draft row missing');
        $body = $this->toDraft($row);
        if ($skipped > 0) {
            $body['attachmentsSkipped'] = $skipped;
        }

        return Json::write($response, $body, $created ? 201 : 200);
    }

    /** Decrypted raw mail of a message of the user; null = not stored. */
    private function loadRaw(string $messageId, string $userId): ?string
    {
        /** @var array{wrapped_dek: string, storage_ref: ?string}|false $row */
        $row = Database::run(
            $this->db->pdo(),
            'SELECT a.wrapped_dek, mb.storage_ref FROM message m JOIN mail_account a ON a.id = m.account_id
             LEFT JOIN message_body mb ON mb.message_id = m.id WHERE m.id = ? AND a.user_id = ?',
            [$messageId, $userId],
        )->fetch();
        if ($row === false || $row['storage_ref'] === null || $row['storage_ref'] === '') {
            return null;
        }

        return $this->storage->read(Envelope::unwrapAccountKey($this->config->get('MASTER_KEY'), $row['wrapped_dek']), $messageId, $row['storage_ref']);
    }

    /** @param array{to: string, cc: string, bcc: string, subject: string, text: string} $content */
    private static function encryptContent(string $dek, string $id, array $content): string
    {
        return Envelope::encryptField($dek, json_encode($content, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), Envelope::draftContentAad($id));
    }

    /** @return list<array{name: string, address: string}> */
    private static function toPeople(mixed $value): array
    {
        if (!\is_array($value)) {
            return [];
        }
        $people = [];
        foreach ($value as $entry) {
            if (\is_array($entry) && \is_string($entry['address'] ?? null)) {
                $people[] = ['name' => \is_scalar($entry['name'] ?? null) ? (string) $entry['name'] : '', 'address' => $entry['address']];
            }
        }

        return $people;
    }

    private function ownsAccount(string $accountId, string $userId): ?string
    {
        if (!Compose::isUuid($accountId)) {
            return null;
        }
        $dek = Database::run($this->db->pdo(), 'SELECT wrapped_dek FROM mail_account WHERE id = ? AND user_id = ?', [strtolower($accountId), $userId])->fetchColumn();

        return \is_string($dek) ? $dek : null;
    }

    /** @return array<string, mixed>|null */
    private function loadOwned(string $id, string $userId): ?array
    {
        if (!Compose::isUuid($id)) {
            return null;
        }
        /** @var array<string, mixed>|false $row */
        $row = Database::run($this->db->pdo(), self::DRAFT_SELECT . ' WHERE d.id = ? AND a.user_id = ? AND d.deleted_at IS NULL', [strtolower($id), $userId])->fetch();

        return $row === false ? null : $row;
    }

    /**
     * @param array<string, mixed> $row
     *
     * @return array<string, mixed>
     */
    private function toDraft(array $row): array
    {
        $id = (string) $row['id'];
        $pdo = $this->db->pdo();
        $content = ['to' => '', 'cc' => '', 'bcc' => '', 'subject' => '', 'text' => ''];
        $dek = null;
        try {
            $dek = Envelope::unwrapAccountKey($this->config->get('MASTER_KEY'), (string) $row['wrapped_dek']);
            if (\is_string($row['content_enc'])) {
                $decoded = json_decode(Envelope::decryptField($dek, $row['content_enc'], Envelope::draftContentAad($id)), true, 64, JSON_THROW_ON_ERROR);
                foreach (array_keys($content) as $key) {
                    if (\is_array($decoded) && \is_string($decoded[$key] ?? null)) {
                        $content[$key] = $decoded[$key];
                    }
                }
            }
        } catch (\Throwable) {
            $this->logger->warn('draft content could not be decrypted', ['draftId' => $id]);
        }
        $messageIds = [];
        if (\is_string($row['message_id_header'])) {
            $messageIds = array_map('strval', Database::run(
                $pdo,
                'SELECT id FROM message WHERE account_id = ? AND message_id_header = ?',
                [$row['account_id'], $row['message_id_header']],
            )->fetchAll(\PDO::FETCH_COLUMN));
        }
        /** @var list<array{id: string, filename_enc: string, content_type: string, size_bytes: int|string}> $uploads */
        $uploads = Database::run(
            $pdo,
            'SELECT id, filename_enc, content_type, size_bytes FROM attachment_upload WHERE draft_id = ? AND outbox_id IS NULL ORDER BY created_at, id',
            [$id],
        )->fetchAll();
        $attachments = [];
        foreach ($uploads as $upload) {
            $filename = 'anhang';
            try {
                if ($dek !== null) {
                    $filename = Envelope::decryptField($dek, $upload['filename_enc'], Envelope::uploadFieldAad('filename', $upload['id']));
                }
            } catch (\Throwable) {
                $this->logger->warn('attachment name could not be decrypted', ['draftId' => $id]);
            }
            $attachments[] = ['id' => $upload['id'], 'filename' => $filename, 'contentType' => $upload['content_type'], 'size' => (int) $upload['size_bytes']];
        }
        $references = json_decode((string) $row['references'], true);

        return [
            'id' => $id,
            'accountId' => $row['account_id'],
            'identityId' => $row['identity_id'],
            'to' => $content['to'],
            'cc' => $content['cc'],
            'bcc' => $content['bcc'],
            'subject' => $content['subject'],
            'text' => $content['text'],
            'inReplyTo' => $row['in_reply_to'],
            'references' => \is_array($references) ? $references : [],
            'version' => (int) $row['version'],
            'createdAt' => Sessions::iso((string) $row['created_at']),
            'updatedAt' => Sessions::iso((string) $row['updated_at']),
            'messageIds' => $messageIds,
            'attachments' => $attachments,
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
