<?php

declare(strict_types=1);

namespace Fma\Routes;

use Fma\Auth\Session;
use Fma\Config;
use Fma\Crypto\Envelope;
use Fma\Db\Database;
use Fma\Http\Body;
use Fma\Http\Json;
use Fma\Http\Middleware\RequireAuth;
use Fma\Log\Logger;
use Fma\Mail\AttachmentNames;
use Fma\Mail\Compose;
use Fma\Mail\RawStorage;
use Fma\Mail\Uploads;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\App;

/**
 * Attachments to send (roadmap 5.3), port of the upload part of
 * apps/api/src/mail/attachments.ts:
 * - POST /api/accounts/{id}/uploads: one file as the raw body
 *   (application/octet-stream, name percent-encoded in X-Filename, type in
 *   X-Content-Type), at most MAX_ATTACHMENT_BYTES, stored encrypted.
 * - DELETE /api/uploads/{id}: removes an upload not yet attached to a message.
 * - POST /api/messages/{id}/attachments/copy: copies a received message's
 *   attachments into uploads of the sending account (forwarding).
 *
 * Unlike Node there is no per-process admission (MAX_CONCURRENT_UPLOADS):
 * PHP-FPM bounds parallel requests itself, and the body is read in chunks
 * only up to the limit. File names are never logged.
 */
final class UploadRoutes
{
    public function __construct(
        private readonly Database $db,
        private readonly Config $config,
        private readonly RawStorage $storage,
        private readonly Logger $logger,
    ) {}

    /** @param App<\Psr\Container\ContainerInterface|null> $app */
    public function register(App $app, RequireAuth $requireAuth): void
    {
        $app->post('/api/accounts/{id}/uploads', $this->upload(...))->add($requireAuth);
        $app->delete('/api/uploads/{id}', $this->delete(...))->add($requireAuth);
        $app->post('/api/messages/{id}/attachments/copy', $this->copy(...))->add($requireAuth);
    }

    /** @param array<string, string> $args */
    private function upload(Request $request, Response $response, array $args): Response
    {
        $account = $this->account(strtolower($args['id'] ?? ''), self::session($request)->userId);
        if ($account === null) {
            return Json::write($response, ['message' => 'Konto nicht gefunden.'], 404);
        }
        $type = strtolower(trim(explode(';', $request->getHeaderLine('Content-Type'))[0]));
        if ($type !== 'application/octet-stream') {
            return Json::write($response, ['message' => 'Erwartet: application/octet-stream.'], 415);
        }
        $maxFileBytes = Compose::attachmentLimits($this->config)['maxFileBytes'];
        $tooLarge = ['message' => 'Die Datei ist zu groß (höchstens ' . Compose::formatByteSize($maxFileBytes) . ').'];
        $declared = $request->getHeaderLine('Content-Length');
        if ($declared !== '' && ctype_digit($declared) && (int) $declared > $maxFileBytes) {
            return Json::write($response, $tooLarge, 413);
        }
        $stream = $request->getBody();
        if ($stream->isSeekable()) {
            $stream->rewind();
        }
        $body = '';
        while (!$stream->eof()) {
            $body .= $stream->read(65536);
            if (\strlen($body) > $maxFileBytes) {
                return Json::write($response, $tooLarge, 413);
            }
        }
        $header = $request->getHeaderLine('X-Filename');
        $decoded = rawurldecode($header);
        if (preg_match('/%(?![0-9A-Fa-f]{2})/', $header) === 1 || !mb_check_encoding($decoded, 'UTF-8')) {
            return Json::write($response, ['message' => 'Ungültiger Dateiname.'], 400);
        }
        $filename = AttachmentNames::sanitizeFilename($decoded);
        $contentType = AttachmentNames::normalizeContentType($request->hasHeader('X-Content-Type') ? $request->getHeaderLine('X-Content-Type') : null);
        $dek = Envelope::unwrapAccountKey($this->config->get('MASTER_KEY'), $account['wrapped_dek']);
        $id = Uploads::insert($this->db->pdo(), $dek, $account['id'], $filename, $contentType, $body, null);
        if ($id === null) {
            return Json::write($response, ['message' => 'Zu viele nicht gesendete Anhänge.'], 429);
        }

        return Json::write($response, ['id' => $id, 'filename' => $filename, 'contentType' => $contentType, 'size' => \strlen($body)], 201);
    }

    /** @param array<string, string> $args */
    private function delete(Request $request, Response $response, array $args): Response
    {
        $id = strtolower($args['id'] ?? '');
        $deleted = Compose::isUuid($id) && Database::run(
            $this->db->pdo(),
            'DELETE u FROM attachment_upload u JOIN mail_account a ON a.id = u.account_id
             WHERE u.id = ? AND a.user_id = ? AND u.outbox_id IS NULL',
            [$id, self::session($request)->userId],
        )->rowCount() > 0;
        if (!$deleted) {
            return Json::write($response, ['message' => 'Anhang nicht gefunden.'], 404);
        }

        return $response->withStatus(204);
    }

    /** @param array<string, string> $args */
    private function copy(Request $request, Response $response, array $args): Response
    {
        $input = Body::json($request);
        $userId = self::session($request)->userId;
        $accountId = $input['accountId'] ?? null;
        $account = \is_string($accountId) ? $this->account(strtolower($accountId), $userId) : null;
        if ($account === null) {
            return Json::write($response, ['message' => 'Konto nicht gefunden.'], 404);
        }
        $messageId = strtolower($args['id'] ?? '');
        /** @var array{wrapped_dek: string, storage_ref: ?string}|false $row */
        $row = Compose::isUuid($messageId) ? Database::run(
            $this->db->pdo(),
            'SELECT a.wrapped_dek, mb.storage_ref FROM message m JOIN mail_account a ON a.id = m.account_id
             LEFT JOIN message_body mb ON mb.message_id = m.id WHERE m.id = ? AND a.user_id = ?',
            [$messageId, $userId],
        )->fetch() : false;
        if ($row === false) {
            return Json::write($response, ['message' => 'Nachricht nicht gefunden.'], 404);
        }
        $raw = $row['storage_ref'] !== null && $row['storage_ref'] !== ''
            ? $this->storage->read(Envelope::unwrapAccountKey($this->config->get('MASTER_KEY'), $row['wrapped_dek']), $messageId, $row['storage_ref'])
            : null;
        if ($raw === null) {
            return Json::write($response, ['message' => 'Der Inhalt dieser Nachricht ist noch nicht synchronisiert.'], 409);
        }
        $dek = Envelope::unwrapAccountKey($this->config->get('MASTER_KEY'), $account['wrapped_dek']);
        try {
            $result = Uploads::copyFromRaw($this->db->pdo(), $this->config, $raw, $account['id'], $dek, null, ($input['includeInline'] ?? false) === true);
        } catch (\PDOException $e) {
            throw $e;
        } catch (\Throwable) {
            $this->logger->warn('raw message could not be parsed', ['messageId' => $messageId]);

            return Json::write($response, ['message' => 'Die Anhänge konnten nicht gelesen werden.'], 422);
        }

        return Json::write($response, $result, 201);
    }

    /** @return array{id: string, wrapped_dek: string}|null */
    private function account(string $accountId, string $userId): ?array
    {
        if (!Compose::isUuid($accountId)) {
            return null;
        }
        /** @var array{id: string, wrapped_dek: string}|false $row */
        $row = Database::run($this->db->pdo(), 'SELECT id, wrapped_dek FROM mail_account WHERE id = ? AND user_id = ?', [$accountId, $userId])->fetch();

        return $row === false ? null : $row;
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
