<?php

declare(strict_types=1);

namespace Fma\Routes;

use Fma\Auth\Session;
use Fma\Config;
use Fma\Crypto\Envelope;
use Fma\Db\Database;
use Fma\Db\Uuid;
use Fma\Http\Json;
use Fma\Http\Middleware\RequireAuth;
use Fma\Log\Logger;
use Fma\Mail\AttachmentNames;
use Fma\Mail\HtmlSanitizer;
use Fma\Mail\MimeMail;
use Fma\Mail\RawStorage;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\App;

/**
 * Content derived on demand from the encrypted raw mail (nothing cached or
 * logged), like apps/api/src/mail/message-html.ts and the read part of
 * attachments.ts (roadmap 2.9, 5.3):
 * - GET /api/messages/{id}/html?remote=0|1: sanitized HTML body, cid:
 *   images embedded as data: URLs, remote resources only with remote=1.
 * - GET /api/messages/{id}/attachments: name, type, size, inline.
 * - GET /api/messages/{id}/attachments/{index}[?inline=1]: decoded content;
 *   only raster images and plain text may be shown inline, everything else
 *   is application/octet-stream as attachment, always nosniff + sandbox CSP.
 * All responses are `Cache-Control: no-store`.
 */
final class MessageContentRoutes
{
    private const NOT_FOUND = 'Nachricht nicht gefunden.';
    private const ATTACHMENT_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox";

    public function __construct(
        private readonly Database $db,
        private readonly Config $config,
        private readonly RawStorage $storage,
        private readonly Logger $logger,
    ) {}

    /** @param App<\Psr\Container\ContainerInterface|null> $app */
    public function register(App $app, RequireAuth $requireAuth): void
    {
        $app->get('/api/messages/{id}/html', $this->html(...))->add($requireAuth);
        $app->get('/api/messages/{id}/attachments', $this->attachments(...))->add($requireAuth);
        $app->get('/api/messages/{id}/attachments/{index}', $this->attachment(...))->add($requireAuth);
    }

    /** @param array<string, string> $args */
    private function html(Request $request, Response $response, array $args): Response
    {
        $response = $response->withHeader('Cache-Control', 'no-store');
        $messageId = strtolower($args['id'] ?? '');
        $raw = $this->loadOwnedRaw($request, $messageId);
        if ($raw === false) {
            return Json::write($response, ['message' => self::NOT_FOUND], 404);
        }
        $empty = ['html' => null, 'remoteContentBlocked' => false];
        if ($raw === null) {
            return Json::write($response, $empty);
        }
        try {
            $mail = MimeMail::parse($raw);
            $html = $mail->html();
            $images = $html === null ? [] : $mail->inlineImages();
        } catch (\Throwable) {
            $this->logger->warn('raw message could not be parsed', ['messageId' => $messageId]);

            return Json::write($response, $empty);
        }
        if ($html === null || $html === '') {
            return Json::write($response, $empty);
        }
        $remote = ($request->getQueryParams()['remote'] ?? null) === '1';

        return Json::write($response, HtmlSanitizer::sanitize($html, $remote, $images));
    }

    /** @param array<string, string> $args */
    private function attachments(Request $request, Response $response, array $args): Response
    {
        $response = $response->withHeader('Cache-Control', 'no-store');
        $messageId = strtolower($args['id'] ?? '');
        $raw = $this->loadOwnedRaw($request, $messageId);
        if ($raw === false) {
            return Json::write($response, ['message' => self::NOT_FOUND], 404);
        }
        $attachments = [];
        if ($raw !== null) {
            try {
                $attachments = MimeMail::parse($raw)->attachments();
            } catch (\Throwable) {
                $this->logger->warn('raw message could not be parsed', ['messageId' => $messageId]);
            }
        }

        return Json::write($response, ['attachments' => $attachments]);
    }

    /** @param array<string, string> $args */
    private function attachment(Request $request, Response $response, array $args): Response
    {
        $response = $response->withHeader('Cache-Control', 'no-store');
        $messageId = strtolower($args['id'] ?? '');
        $indexParam = $args['index'] ?? '';
        $raw = preg_match('/^\d{1,9}$/', $indexParam) === 1 ? $this->loadOwnedRaw($request, $messageId) : false;
        $opened = null;
        if (\is_string($raw)) {
            try {
                $opened = MimeMail::parse($raw)->attachment((int) $indexParam);
            } catch (\Throwable) {
                $this->logger->warn('raw message could not be parsed', ['messageId' => $messageId]);
            }
        }
        if ($opened === null) {
            return Json::write($response, ['message' => 'Anhang nicht gefunden.'], 404);
        }
        $meta = $opened['meta'];
        $safe = AttachmentNames::isInlineSafeType($meta['contentType']);
        $inline = $safe && ($request->getQueryParams()['inline'] ?? null) === '1';
        $response->getBody()->write($opened['content']);

        return $response
            ->withHeader('Content-Type', $safe ? $meta['contentType'] : 'application/octet-stream')
            ->withHeader('Content-Disposition', AttachmentNames::contentDisposition($inline ? 'inline' : 'attachment', $meta['filename']))
            ->withHeader('X-Content-Type-Options', 'nosniff')
            ->withHeader('Content-Security-Policy', self::ATTACHMENT_CSP)
            ->withHeader('Cross-Origin-Resource-Policy', 'same-origin')
            ->withHeader('Referrer-Policy', 'no-referrer');
    }

    /**
     * Decrypted raw mail of a message of the user; false = no such message
     * (or foreign), null = raw mail not stored (yet) or unreadable.
     */
    private function loadOwnedRaw(Request $request, string $messageId): string|false|null
    {
        if (!Uuid::isValid($messageId)) {
            return false;
        }
        $session = $request->getAttribute('auth');
        if (!$session instanceof Session) {
            throw new \LogicException('route without RequireAuth');
        }
        /** @var array{wrapped_dek: string, storage_ref: ?string}|false $row */
        $row = Database::run(
            $this->db->pdo(),
            'SELECT a.wrapped_dek, mb.storage_ref
             FROM message m
             JOIN mail_account a ON a.id = m.account_id
             LEFT JOIN message_body mb ON mb.message_id = m.id
             WHERE m.id = ? AND a.user_id = ?',
            [$messageId, $session->userId],
        )->fetch();
        if ($row === false) {
            return false;
        }
        if ($row['storage_ref'] === null || $row['storage_ref'] === '') {
            return null;
        }
        $dek = Envelope::unwrapAccountKey($this->config->get('MASTER_KEY'), $row['wrapped_dek']);

        return $this->storage->read($dek, $messageId, $row['storage_ref']);
    }
}
