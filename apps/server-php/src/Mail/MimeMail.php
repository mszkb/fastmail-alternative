<?php

declare(strict_types=1);

namespace Fma\Mail;

use ZBateson\MailMimeParser\IMessage;
use ZBateson\MailMimeParser\MailMimeParser;
use ZBateson\MailMimeParser\Message\IMessagePart;

/**
 * Read-only view of a decrypted raw mail (zbateson/mail-mime-parser): the
 * HTML body, inline raster images (cid:) and the list
 * of attachments. Every non-body part counts as an attachment (index order
 * of the MIME tree); parts inside multipart/related are `inline`.
 */
final class MimeMail
{
    /** Raster types embedded as data: URLs for cid: references. */
    private const INLINE_IMAGE_TYPES = ['image/png', 'image/gif', 'image/jpeg', 'image/jpg', 'image/webp', 'image/bmp', 'image/avif'];
    /** Upper bound for all inline images of one message together (data: URL bytes). */
    private const MAX_INLINE_TOTAL = 15 * 1024 * 1024;

    private function __construct(private readonly IMessage $message) {}

    public static function parse(string $raw): self
    {
        $stream = fopen('php://temp', 'r+b');
        if ($stream === false) {
            throw new \RuntimeException('cannot open temp stream');
        }
        fwrite($stream, $raw);
        rewind($stream);

        return new self((new MailMimeParser())->parse($stream, false));
    }

    public function html(): ?string
    {
        return $this->message->getHtmlContent();
    }

    /**
     * Content-ID (lowercase, without angle brackets) -> data: URL for inline
     * raster images within the size limits.
     *
     * @return array<string, string>
     */
    public function inlineImages(): array
    {
        $images = [];
        $total = 0;
        $maxBytes = intdiv(HtmlSanitizer::MAX_DATA_URL_LENGTH * 3, 4);
        foreach ($this->message->getAllAttachmentParts() as $part) {
            $cid = strtolower(trim((string) preg_replace('/^<|>$/', '', (string) $part->getContentId())));
            $type = strtolower((string) $part->getContentType(''));
            if ($cid === '' || !\in_array($type, self::INLINE_IMAGE_TYPES, true)) {
                continue;
            }
            $content = self::content($part);
            if (\strlen($content) > $maxBytes) {
                continue;
            }
            $url = "data:{$type};base64," . base64_encode($content);
            if (\strlen($url) <= HtmlSanitizer::MAX_DATA_URL_LENGTH && $total + \strlen($url) <= self::MAX_INLINE_TOTAL) {
                $total += \strlen($url);
                $images[$cid] = $url;
            }
        }

        return $images;
    }

    /** @return list<array{index: int, filename: string, contentType: string, size: int, inline: bool}> */
    public function attachments(): array
    {
        $list = [];
        foreach (array_values($this->message->getAllAttachmentParts()) as $index => $part) {
            $list[] = self::meta($part, $index, \strlen(self::content($part)));
        }

        return $list;
    }

    /** @return array{meta: array{index: int, filename: string, contentType: string, size: int, inline: bool}, content: string}|null */
    public function attachment(int $index): ?array
    {
        $parts = array_values($this->message->getAllAttachmentParts());
        $part = $parts[$index] ?? null;
        if ($part === null) {
            return null;
        }
        $content = self::content($part);

        return ['meta' => self::meta($part, $index, \strlen($content)), 'content' => $content];
    }

    /** @return array{index: int, filename: string, contentType: string, size: int, inline: bool} */
    private static function meta(IMessagePart $part, int $index, int $size): array
    {
        $parent = $part->getParent();

        return [
            'index' => $index,
            'filename' => AttachmentNames::sanitizeFilename($part->getFilename(), 'anhang-' . ($index + 1)),
            'contentType' => AttachmentNames::normalizeContentType($part->getContentType('application/octet-stream')),
            'size' => $size,
            'inline' => $parent !== null && strtolower((string) $parent->getContentType('')) === 'multipart/related',
        ];
    }

    /** Decoded bytes (transfer encoding removed, no charset conversion). */
    private static function content(IMessagePart $part): string
    {
        $stream = $part->getBinaryContentStream();

        return $stream === null ? '' : $stream->getContents();
    }
}
