<?php

declare(strict_types=1);

namespace Fma\Mail;

use Fma\Config;
use Fma\Crypto\Envelope;
use Fma\Db\Database;
use Fma\Db\Uuid;

/**
 * Encrypted attachment uploads (roadmap 5.3), port of the helpers in
 * apps/api/src/mail/attachments.ts and apps/worker/src/uploads.ts.
 *
 * Per account at most MAX_PENDING_UPLOADS uploads without draft/message and
 * MAX_DRAFT_UPLOADS kept with drafts; "count + insert" is serialized by a
 * row lock on the account (MySQL has no advisory transaction locks).
 * File names are mail content: encrypted at rest, never logged.
 */
final class Uploads
{
    public const MAX_PENDING_UPLOADS = 100;
    public const MAX_DRAFT_UPLOADS = 200;
    /** Inline image types taken over when forwarding, with the extension for unnamed ones. */
    public const FORWARD_INLINE_IMAGE_TYPES = ['image/png' => 'png', 'image/jpeg' => 'jpg', 'image/gif' => 'gif', 'image/webp' => 'webp'];

    /** Serializes "count + insert/attach" of an account's uploads until the end of the transaction. */
    public static function lockAccount(\PDO $pdo, string $accountId): void
    {
        Database::run($pdo, 'SELECT id FROM mail_account WHERE id = ? FOR UPDATE', [$accountId]);
    }

    public static function countDraftUploads(\PDO $pdo, string $accountId): int
    {
        return (int) Database::run(
            $pdo,
            'SELECT COUNT(*) FROM attachment_upload WHERE account_id = ? AND draft_id IS NOT NULL AND outbox_id IS NULL',
            [$accountId],
        )->fetchColumn();
    }

    /**
     * Inserts an encrypted upload unless the account's limit for its kind is
     * reached; returns the new id, or null when the limit is reached (nothing inserted).
     */
    public static function insert(\PDO $pdo, string $dek, string $accountId, string $filename, string $contentType, string $content, ?string $draftId): ?string
    {
        $id = Uuid::v4();
        $pdo->beginTransaction();
        try {
            self::lockAccount($pdo, $accountId);
            $count = $draftId !== null
                ? self::countDraftUploads($pdo, $accountId)
                : (int) Database::run(
                    $pdo,
                    'SELECT COUNT(*) FROM attachment_upload WHERE account_id = ? AND draft_id IS NULL AND outbox_id IS NULL',
                    [$accountId],
                )->fetchColumn();
            if ($count >= ($draftId !== null ? self::MAX_DRAFT_UPLOADS : self::MAX_PENDING_UPLOADS)) {
                $pdo->rollBack();

                return null;
            }
            Database::run(
                $pdo,
                'INSERT INTO attachment_upload (id, account_id, filename_enc, content_type, size_bytes, content_enc, draft_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?)',
                [
                    $id, $accountId,
                    Envelope::encryptField($dek, $filename, Envelope::uploadFieldAad('filename', $id)),
                    $contentType, \strlen($content),
                    Envelope::encryptBytes($dek, $content, Envelope::uploadFieldAad('content', $id)),
                    $draftId,
                ],
            );
            $pdo->commit();
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }

        return $id;
    }

    /**
     * Decrypted uploads bound to an outbox message or kept with a draft, in upload order.
     *
     * @return list<array{filename: string, contentType: string, content: string}>
     */
    public static function load(\PDO $pdo, string $dek, ?string $outboxId, ?string $draftId = null): array
    {
        /** @var list<array{id: string, filename_enc: string, content_type: string, content_enc: string}> $rows */
        $rows = $outboxId !== null
            ? Database::run($pdo, 'SELECT id, filename_enc, content_type, content_enc FROM attachment_upload WHERE outbox_id = ? ORDER BY created_at, id', [$outboxId])->fetchAll()
            : Database::run($pdo, 'SELECT id, filename_enc, content_type, content_enc FROM attachment_upload WHERE draft_id = ? AND outbox_id IS NULL ORDER BY created_at, id', [$draftId])->fetchAll();

        return array_map(static fn(array $row): array => [
            'filename' => Envelope::decryptField($dek, $row['filename_enc'], Envelope::uploadFieldAad('filename', $row['id'])),
            'contentType' => $row['content_type'],
            'content' => Envelope::decryptBytes($dek, $row['content_enc'], Envelope::uploadFieldAad('content', $row['id'])),
        ], $rows);
    }

    /**
     * Copies the (non-inline) attachments of a raw mail into encrypted
     * uploads of the account, optionally kept with `draftId`. With
     * `includeInline` inline raster images are copied too (`bild-N.<ext>`
     * when unnamed). Attachments beyond the limits are skipped and counted.
     *
     * @return array{attachments: list<array{id: string, filename: string, contentType: string, size: int}>, skipped: int}
     */
    public static function copyFromRaw(\PDO $pdo, Config $config, string $raw, string $accountId, string $dek, ?string $draftId = null, bool $includeInline = false): array
    {
        $mail = MimeMail::parse($raw);
        $list = array_values(array_filter(
            $mail->attachments(),
            static fn(array $a): bool => !$a['inline'] || ($includeInline && isset(self::FORWARD_INLINE_IMAGE_TYPES[$a['contentType']])),
        ));
        $limits = Compose::attachmentLimits($config);
        $attachments = [];
        $total = 0;
        $skipped = 0;
        $full = false;
        $inlineCount = 0;
        foreach ($list as $meta) {
            if ($full || \count($attachments) >= Compose::MAX_ATTACHMENT_COUNT || $meta['size'] > $limits['maxFileBytes'] || $total + $meta['size'] > $limits['maxTotalBytes']) {
                ++$skipped;
                continue;
            }
            $opened = $mail->attachment($meta['index']);
            if ($opened === null) {
                ++$skipped;
                continue;
            }
            $filename = $opened['meta']['filename'];
            $contentType = $opened['meta']['contentType'];
            if ($meta['inline']) {
                ++$inlineCount;
                if ($filename === 'anhang-' . ($meta['index'] + 1)) {
                    $filename = "bild-{$inlineCount}." . self::FORWARD_INLINE_IMAGE_TYPES[$contentType];
                }
            }
            $content = $opened['content'];
            $id = self::insert($pdo, $dek, $accountId, $filename, $contentType, $content, $draftId);
            if ($id === null) {
                $full = true;
                ++$skipped;
                continue;
            }
            $total += \strlen($content);
            $attachments[] = ['id' => $id, 'filename' => $filename, 'contentType' => $contentType, 'size' => \strlen($content)];
        }

        return ['attachments' => $attachments, 'skipped' => $skipped];
    }
}
