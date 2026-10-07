<?php

declare(strict_types=1);

namespace Fma\Mail;

/**
 * Builds plain-text RFC 5322 messages with optional attachments, like
 * nodemailer's MailComposer in apps/worker (send_message, draft_sync).
 * Everything is 7-bit: headers as RFC 2047 encoded words, the text as
 * quoted-printable, attachments as base64 (file names RFC 2231), so no
 * 8BITMIME/SMTPUTF8 is needed. Bcc is written only with `keepBcc` (the
 * copies in Sent/Drafts). Never logs anything.
 */
final class MimeBuilder
{
    /**
     * @param array{
     *   from: array{name: string, address: string},
     *   to: list<array{name: string, address: string}>,
     *   cc: list<array{name: string, address: string}>,
     *   bcc: list<array{name: string, address: string}>,
     *   subject: string,
     *   text: string,
     *   messageId: string,
     *   date: \DateTimeInterface,
     *   inReplyTo?: ?string,
     *   references?: list<string>,
     * } $mail
     * @param list<array{filename: string, contentType: string, content: string}> $attachments
     */
    public static function build(array $mail, array $attachments = [], bool $keepBcc = false): string
    {
        $headers = [];
        $headers[] = 'From: ' . self::person($mail['from']);
        if ($mail['to'] !== []) {
            $headers[] = 'To: ' . self::people($mail['to']);
        }
        if ($mail['cc'] !== []) {
            $headers[] = 'Cc: ' . self::people($mail['cc']);
        }
        if ($keepBcc && $mail['bcc'] !== []) {
            $headers[] = 'Bcc: ' . self::people($mail['bcc']);
        }
        $headers[] = 'Subject: ' . self::encodeHeader(self::singleLine($mail['subject']), 9);
        $headers[] = 'Message-ID: ' . self::singleLine($mail['messageId']);
        $headers[] = 'Date: ' . $mail['date']->format(\DateTimeInterface::RFC2822);
        if (($mail['inReplyTo'] ?? null) !== null && $mail['inReplyTo'] !== '') {
            $headers[] = 'In-Reply-To: ' . self::singleLine($mail['inReplyTo']);
        }
        $references = $mail['references'] ?? [];
        if ($references !== []) {
            $headers[] = 'References: ' . implode("\r\n ", array_map(self::singleLine(...), $references));
        }
        $headers[] = 'MIME-Version: 1.0';

        $text = self::textPart($mail['text']);
        if ($attachments === []) {
            return implode("\r\n", $headers) . "\r\n" . $text;
        }
        $boundary = '----=_Part_' . bin2hex(random_bytes(12));
        $headers[] = "Content-Type: multipart/mixed; boundary=\"{$boundary}\"";
        $body = "--{$boundary}\r\n{$text}\r\n";
        foreach ($attachments as $attachment) {
            $body .= "--{$boundary}\r\n" . self::attachmentPart($attachment) . "\r\n";
        }

        return implode("\r\n", $headers) . "\r\n\r\n" . $body . "--{$boundary}--\r\n";
    }

    /**
     * Envelope recipients (to, cc, bcc), unique, case-insensitive.
     *
     * @param list<array{name: string, address: string}> ...$lists
     *
     * @return list<string>
     */
    public static function envelopeRecipients(array ...$lists): array
    {
        $seen = [];
        $result = [];
        foreach ($lists as $people) {
            foreach ($people as $person) {
                $key = strtolower($person['address']);
                if (!isset($seen[$key])) {
                    $seen[$key] = true;
                    $result[] = $person['address'];
                }
            }
        }

        return $result;
    }

    /** Headers + empty line + body of the text part (headers of the part only). */
    private static function textPart(string $text): string
    {
        $normalized = (string) preg_replace('/\r\n?|\n/', "\r\n", $text);

        return "Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n"
            . quoted_printable_encode($normalized) . "\r\n";
    }

    /** @param array{filename: string, contentType: string, content: string} $attachment */
    private static function attachmentPart(array $attachment): string
    {
        $type = AttachmentNames::normalizeContentType($attachment['contentType']);
        $name = AttachmentNames::sanitizeFilename($attachment['filename']);

        return "Content-Type: {$type}; " . self::fileParam('name', $name) . "\r\n"
            . 'Content-Disposition: attachment; ' . self::fileParam('filename', $name) . "\r\n"
            . "Content-Transfer-Encoding: base64\r\n\r\n"
            . rtrim(chunk_split(base64_encode($attachment['content']), 76, "\r\n"), "\r\n") . "\r\n";
    }

    /** `name="ascii"` or RFC 2231 `name*=UTF-8''percent-encoded`. */
    private static function fileParam(string $param, string $value): string
    {
        if (preg_match('/^[\x20-\x7e]*$/', $value) === 1 && \strlen($value) < 60) {
            return $param . '="' . str_replace(['\\', '"'], ['\\\\', '\\"'], $value) . '"';
        }

        return "{$param}*=UTF-8''" . rawurlencode($value);
    }

    /** @param list<array{name: string, address: string}> $people */
    private static function people(array $people): string
    {
        return implode(",\r\n ", array_map(self::person(...), $people));
    }

    /** @param array{name: string, address: string} $person */
    private static function person(array $person): string
    {
        $address = self::singleLine($person['address']);
        $name = self::singleLine($person['name']);
        if ($name === '') {
            return $address;
        }
        if (preg_match('/^[\x20-\x7e]*$/', $name) === 1) {
            $display = preg_match('/^[A-Za-z0-9!#$%&\'*+\/=?^_`{|}~. -]+$/', $name) === 1
                ? $name
                : '"' . str_replace(['\\', '"'], ['\\\\', '\\"'], $name) . '"';
        } else {
            $display = self::encodeWords($name);
        }

        return "{$display} <{$address}>";
    }

    /** ASCII values that fit stay as they are; anything else becomes encoded words. */
    private static function encodeHeader(string $value, int $prefixLength): string
    {
        if (preg_match('/^[\x20-\x7e]*$/', $value) === 1 && \strlen($value) + $prefixLength <= 76) {
            return $value;
        }

        return self::encodeWords($value);
    }

    /** RFC 2047 base64 encoded words (whole characters per word), folded. */
    private static function encodeWords(string $value): string
    {
        $words = [];
        $chunk = '';
        foreach (mb_str_split($value, 1, 'UTF-8') as $char) {
            if (\strlen($chunk . $char) > 45) {
                $words[] = '=?UTF-8?B?' . base64_encode($chunk) . '?=';
                $chunk = '';
            }
            $chunk .= $char;
        }
        if ($chunk !== '') {
            $words[] = '=?UTF-8?B?' . base64_encode($chunk) . '?=';
        }

        return implode("\r\n ", $words);
    }

    private static function singleLine(string $value): string
    {
        return trim((string) preg_replace('/[\r\n]+/', ' ', $value));
    }
}
