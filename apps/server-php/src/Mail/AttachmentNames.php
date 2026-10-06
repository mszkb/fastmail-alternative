<?php

declare(strict_types=1);

namespace Fma\Mail;

/**
 * Attachment name/type policy, port of packages/shared/src/attachments.ts
 * (normalizeContentType, isInlineSafeType, sanitizeFilename,
 * contentDisposition).
 */
final class AttachmentNames
{
    /** Longest accepted file name (characters). */
    public const MAX_FILENAME_LENGTH = 255;

    /**
     * Types a browser may render inline without running code (served with
     * nosniff and a sandbox CSP); everything else is always downloaded.
     */
    private const INLINE_SAFE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'text/plain'];

    private const MIME_TYPE_RE = '/^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/';

    /** Normalizes a declared MIME type; invalid or missing -> application/octet-stream. */
    public static function normalizeContentType(mixed $value): string
    {
        if (!\is_string($value)) {
            return 'application/octet-stream';
        }
        $type = strtolower(trim(explode(';', $value)[0]));
        if ($type === 'image/jpg') {
            return 'image/jpeg';
        }

        return preg_match(self::MIME_TYPE_RE, $type) === 1 ? $type : 'application/octet-stream';
    }

    public static function isInlineSafeType(string $contentType): bool
    {
        return \in_array(self::normalizeContentType($contentType), self::INLINE_SAFE_TYPES, true);
    }

    /** No path parts, no control characters, bounded length; empty -> fallback. */
    public static function sanitizeFilename(mixed $value, string $fallback = 'anhang'): string
    {
        $raw = \is_string($value) ? $value : '';
        if (!mb_check_encoding($raw, 'UTF-8')) {
            $raw = mb_scrub($raw, 'UTF-8');
        }
        $parts = preg_split('/[\\\\\/]/', $raw);
        $base = $parts === false ? '' : (string) end($parts);
        $cleaned = trim((string) preg_replace('/[\x00-\x1f\x7f"]+/', '', $base));
        if (preg_match('/^\.+$/', $cleaned) === 1) {
            $cleaned = '';
        }
        $name = $cleaned !== '' ? $cleaned : $fallback;

        return mb_strlen($name) > self::MAX_FILENAME_LENGTH ? mb_substr($name, 0, self::MAX_FILENAME_LENGTH) : $name;
    }

    /** Content-Disposition with an ASCII fallback and the RFC 5987 UTF-8 `filename*` parameter. */
    public static function contentDisposition(string $kind, string $filename): string
    {
        $name = self::sanitizeFilename($filename);
        $ascii = (string) preg_replace('/[\\\\"]/', '_', (string) preg_replace('/[^\x20-\x7e]/u', '_', $name));
        $encoded = str_replace(['%21', '%7E', '%27', '%28', '%29', '%2A'], ['!', '~', '%27', '%28', '%29', '%2A'], rawurlencode($name));

        return "{$kind}; filename=\"{$ascii}\"; filename*=UTF-8''{$encoded}";
    }
}
