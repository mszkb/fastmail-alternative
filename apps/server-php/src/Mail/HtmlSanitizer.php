<?php

declare(strict_types=1);

namespace Fma\Mail;

use Masterminds\HTML5;

/**
 * Sanitizer for HTML mail bodies (roadmap 2.9).
 *
 * The HTML is parsed with the HTML5 parser (masterminds/html5, the parser
 * behind symfony/html-sanitizer) and re-serialized from the DOM with a
 * strict tag/attribute allowlist, so parser differentials can only drop
 * content, never inject markup:
 * - disallowed tags are discarded but their text kept, except NON_TEXT_TAGS
 *   (script, iframe, svg, ...) whose content is dropped as well; comments
 *   are dropped; <body> becomes a <div> carrying its colors;
 * - every URL goes through one policy: links only http(s)/mailto,
 *   resources only data:image/* (raster, incl. resolved cid: references)
 *   and - only with allowRemote - absolute http(s) URLs. Dropped remote
 *   resources set remoteContentBlocked;
 * - <style> text and style attributes go through sanitizeCss() (URL policy,
 *   no @import/expression(), never a `<`).
 */
final class HtmlSanitizer
{
    /** Inline data URLs above this size are dropped (protects the client). */
    public const MAX_DATA_URL_LENGTH = 5 * 1024 * 1024;
    private const NESTING_LIMIT = 100;

    private const ALLOWED_TAGS = [
        'a', 'abbr', 'address', 'article', 'aside', 'b', 'bdi', 'bdo', 'big', 'blockquote', 'br', 'caption',
        'center', 'cite', 'code', 'col', 'colgroup', 'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em',
        'figcaption', 'figure', 'font', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'i', 'img',
        'ins', 'kbd', 'li', 'main', 'mark', 'nav', 'ol', 'p', 'pre', 'q', 's', 'samp', 'section', 'small', 'span',
        'strike', 'strong', 'style', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
        'time', 'tr', 'tt', 'u', 'ul', 'var', 'wbr',
    ];

    /** Disallowed tags whose content is dropped as well (not rendered as text). */
    private const NON_TEXT_TAGS = [
        'script', 'textarea', 'option', 'select', 'xmp', 'title', 'noscript', 'noembed', 'noframes', 'iframe',
        'template', 'svg', 'math', 'object', 'embed', 'applet',
    ];

    private const VOID_TAGS = ['br', 'hr', 'img', 'col', 'wbr'];

    private const TABLE_ATTRS = ['align', 'valign', 'bgcolor', 'background', 'width', 'height'];
    private const GLOBAL_ATTRS = ['style', 'class', 'title', 'dir', 'lang', 'align', 'valign'];
    private const ALLOWED_ATTRIBUTES = [
        'a' => ['href', 'target', 'rel'],
        'img' => ['src', 'alt', 'width', 'height', 'border', 'hspace', 'vspace', 'referrerpolicy'],
        'font' => ['color', 'face', 'size'],
        'ol' => ['start', 'type', 'reversed'],
        'ul' => ['type'],
        'li' => ['value'],
        'table' => [...self::TABLE_ATTRS, 'border', 'cellpadding', 'cellspacing', 'summary', 'frame', 'rules'],
        'tr' => self::TABLE_ATTRS,
        'td' => [...self::TABLE_ATTRS, 'colspan', 'rowspan', 'nowrap', 'scope', 'headers'],
        'th' => [...self::TABLE_ATTRS, 'colspan', 'rowspan', 'nowrap', 'scope', 'headers', 'abbr'],
        'tbody' => self::TABLE_ATTRS,
        'thead' => self::TABLE_ATTRS,
        'tfoot' => self::TABLE_ATTRS,
        'col' => ['span', 'width', 'align', 'valign'],
        'colgroup' => ['span', 'width', 'align', 'valign'],
        'div' => ['bgcolor'],
        'hr' => ['size', 'width', 'noshade', 'color'],
        'time' => ['datetime'],
        'details' => ['open'],
        'blockquote' => ['cite'],
        'q' => ['cite'],
        'del' => ['cite', 'datetime'],
        'ins' => ['cite', 'datetime'],
        'bdo' => ['dir'],
    ];

    /** Inline images: raster formats only (no SVG, which may carry scripts/links). */
    private const DATA_IMAGE_RE = '/^data:image\/(?:png|gif|jpe?g|webp|bmp|avif);base64,[a-z0-9+\/=\s]*$/i';
    private const COLOR_RE = '/^#?[0-9a-z]{1,20}$/i';
    /** CSS functions that can load resources without url() or execute code in legacy engines. */
    private const BLOCKED_CSS_FUNCTION_RE = '/(?<![\w-])(?:-webkit-|-moz-)?(?:image-set|image|cross-fade|element|paint|expression|src)\s*\(/i';

    private bool $remoteBlocked = false;

    /** @param array<string, string> $inlineImages Content-ID (lowercase, no brackets) -> data: URL */
    private function __construct(private readonly bool $allowRemote, private readonly array $inlineImages) {}

    /**
     * Sanitizes an HTML mail body (fragment or full document).
     *
     * @param array<string, string> $inlineImages
     *
     * @return array{html: string, remoteContentBlocked: bool}
     */
    public static function sanitize(string $html, bool $allowRemote, array $inlineImages = []): array
    {
        $self = new self($allowRemote, $inlineImages);
        if (!mb_check_encoding($html, 'UTF-8')) {
            $html = mb_scrub($html, 'UTF-8');
        }
        $dom = (new HTML5(['disable_html_ns' => true]))->loadHTML($html);
        $out = '';
        foreach ($dom->childNodes as $child) {
            $out .= $self->node($child, 0);
        }

        return ['html' => $out, 'remoteContentBlocked' => $self->remoteBlocked];
    }

    private function node(\DOMNode $node, int $depth): string
    {
        if ($node instanceof \DOMText) {
            return htmlspecialchars($node->data, ENT_NOQUOTES | ENT_SUBSTITUTE, 'UTF-8');
        }
        if (!$node instanceof \DOMElement) {
            return ''; // comments, doctype, processing instructions
        }
        $tag = strtolower($node->localName ?? $node->tagName);
        if (\in_array($tag, self::NON_TEXT_TAGS, true)) {
            return '';
        }
        $attributes = [];
        foreach ($node->attributes as $attribute) {
            $attributes[strtolower($attribute->name)] = $attribute->value;
        }
        if ($tag === 'body') {
            // Keep the body's colors: a div carries them inside the fragment.
            $style = [];
            $bgcolor = trim($attributes['bgcolor'] ?? '');
            if ($bgcolor !== '' && preg_match(self::COLOR_RE, $bgcolor) === 1) {
                $style[] = "background-color: {$bgcolor}";
            }
            if (($attributes['style'] ?? '') !== '') {
                $style[] = $attributes['style'];
            }
            $tag = 'div';
            $attributes = $style !== [] ? ['style' => implode('; ', $style)] : [];
        }
        $allowed = \in_array($tag, self::ALLOWED_TAGS, true) && $depth < self::NESTING_LIMIT;
        if (!$allowed) {
            return $this->children($node, $depth);
        }
        if ($tag === 'style') {
            // Raw text element: its CSS is rewritten (no `<` left), no attributes.
            return '<style>' . $this->sanitizeCss((string) $node->textContent) . '</style>';
        }
        $html = "<{$tag}";
        foreach ($this->attributes($tag, $attributes) as $name => $value) {
            $html .= " {$name}=\"" . htmlspecialchars($value, ENT_COMPAT | ENT_SUBSTITUTE, 'UTF-8') . '"';
        }
        if (\in_array($tag, self::VOID_TAGS, true)) {
            return $html . ' />';
        }

        return $html . '>' . $this->children($node, $depth + 1) . "</{$tag}>";
    }

    private function children(\DOMNode $node, int $depth): string
    {
        $out = '';
        foreach ($node->childNodes as $child) {
            $out .= $this->node($child, $depth);
        }

        return $out;
    }

    /**
     * Applies the URL/color/CSS policies, then the attribute allowlist.
     *
     * @param array<string, string> $attributes
     *
     * @return array<string, string>
     */
    private function attributes(string $tag, array $attributes): array
    {
        $allowed = [...self::GLOBAL_ATTRS, ...(self::ALLOWED_ATTRIBUTES[$tag] ?? [])];
        $out = [];
        foreach ($attributes as $name => $value) {
            if (!\in_array($name, $allowed, true)) {
                continue;
            }
            if ($name === 'style') {
                $style = trim($this->sanitizeCss($value));
                if ($style !== '') {
                    $out['style'] = $style;
                }
            } elseif ($name === 'src' || $name === 'background') {
                $url = $this->resolveResourceUrl($value);
                // Only <img> may carry data: URLs (sanitize-html's allowedSchemesByTag).
                if ($url !== null && ($tag === 'img' || !str_starts_with($url, 'data:'))) {
                    $out[$name] = $url;
                }
            } elseif ($name === 'href') {
                $href = self::safeHref($value);
                if ($href !== null) {
                    $out['href'] = $href;
                }
            } elseif ($name === 'bgcolor' || $name === 'color') {
                if (preg_match(self::COLOR_RE, trim($value)) === 1) {
                    $out[$name] = trim($value);
                }
            } elseif ($name === 'cite') {
                if (self::safeCite($value)) {
                    $out['cite'] = $value;
                }
            } elseif ($name !== 'target' && $name !== 'rel' && $name !== 'referrerpolicy') {
                $out[$name] = $value;
            }
        }
        if ($tag === 'a') {
            $out['target'] = '_blank';
            $out['rel'] = 'noopener noreferrer nofollow';
        }
        if ($tag === 'img') {
            $out['referrerpolicy'] = 'no-referrer';
        }

        return $out;
    }

    /** Browsers strip leading/trailing C0 controls and spaces and remove tab/newline anywhere in URLs. */
    private static function normalizeUrl(string $raw): string
    {
        return (string) preg_replace('/^[\x00-\x20]+|[\x00-\x20]+$/', '', str_replace(["\t", "\n", "\r"], '', $raw));
    }

    /** Absolute http(s) URL (protocol-relative counts as https), percent-encoded, or null. */
    private static function parseHttpUrl(string $value): ?string
    {
        $candidate = str_starts_with($value, '//') ? "https:{$value}" : $value;
        if (preg_match('#^(https?)://([^/?\#\\\\@]*@)?([^/?\#\\\\:@]+)(:\d{0,5})?([/?\#].*)?$#is', $candidate, $m, PREG_UNMATCHED_AS_NULL) !== 1) {
            return null;
        }
        $host = strtolower($m[3]);
        if (preg_match('/^[\p{L}\p{N}.\-\[\]_]+$/u', $host) !== 1) {
            return null;
        }
        $path = $m[5] ?? '';

        return self::encodeUrl(strtolower($m[1]) . '://' . ($m[2] ?? '') . $host . ($m[4] ?? '') . ($path === '' ? '/' : $path));
    }

    /** Percent-encodes characters a URL must not contain literally (like WHATWG URL serialization). */
    private static function encodeUrl(string $url): string
    {
        return (string) preg_replace_callback(
            '/[^\x21-\x7e]|["<>`]/',
            static fn(array $m): string => rawurlencode($m[0]),
            $url,
        );
    }

    /**
     * URL policy for resources (img src, background, CSS url()). Returns the
     * URL to keep or null to drop it.
     */
    private function resolveResourceUrl(string $raw): ?string
    {
        $value = self::normalizeUrl($raw);
        $lower = strtolower($value);
        if (str_starts_with($lower, 'cid:')) {
            $cid = rawurldecode(substr($value, 4));
            $cid = strtolower((string) preg_replace('/^<|>$/', '', $cid));

            return $this->inlineImages[$cid] ?? null;
        }
        if (str_starts_with($lower, 'data:')) {
            return \strlen($value) <= self::MAX_DATA_URL_LENGTH && preg_match(self::DATA_IMAGE_RE, $value) === 1 ? $value : null;
        }
        $url = self::parseHttpUrl($value);
        if ($url === null) {
            return null; // relative, javascript:, file:, ... never loaded
        }
        if (!$this->allowRemote) {
            $this->remoteBlocked = true;

            return null;
        }

        return $url;
    }

    /** Link policy: absolute http(s) and mailto only. */
    private static function safeHref(string $raw): ?string
    {
        $value = self::normalizeUrl($raw);
        $http = self::parseHttpUrl($value);
        if ($http !== null) {
            return $http;
        }
        if (preg_match('/^mailto:/i', $value) === 1) {
            return 'mailto:' . self::encodeUrl(substr($value, 7));
        }

        return null;
    }

    /** cite: relative URLs or http(s)/mailto, never protocol-relative (sanitize-html's scheme check). */
    private static function safeCite(string $raw): bool
    {
        $value = (string) preg_replace('/[\x00-\x20]+/', '', $raw);
        if (str_starts_with($value, '//')) {
            return false;
        }
        if (preg_match('/^([a-z][a-z0-9.\-+]*):/i', $value, $m) !== 1) {
            return true;
        }

        return \in_array(strtolower($m[1]), ['http', 'https', 'mailto'], true);
    }

    /** Decodes CSS escapes (`\75 rl`, `\u`) so filtering sees what the browser sees. */
    private static function decodeCssEscapes(string $css): string
    {
        return (string) preg_replace_callback(
            '/\\\\(?:([0-9a-f]{1,6})[ \t\n\r\f]?|(\r\n|[\n\r\f])|(.))/isu',
            static function (array $m): string {
                if (isset($m[2]) && $m[2] !== '') {
                    return '';
                }
                if (isset($m[3])) {
                    return $m[3];
                }
                $code = (int) hexdec($m[1]);
                if ($code === 0 || $code > 0x10FFFF || ($code >= 0xD800 && $code <= 0xDFFF)) {
                    return "\u{FFFD}";
                }

                return mb_chr($code, 'UTF-8') ?: "\u{FFFD}";
            },
            $css,
        );
    }

    /** Quotes a URL for CSS url("..."): characters that could end the token are percent-encoded. */
    private static function cssUrl(string $url): string
    {
        return 'url("' . preg_replace_callback('/["\'()\\\\\s<>]/', static fn(array $m): string => \sprintf('%%%02x', \ord($m[0])), $url) . '")';
    }

    /**
     * Sanitizes a style sheet or an inline declaration list. Lossy for
     * exotic CSS but never lets a resource URL through that the URL policy
     * rejects, and never emits `<`.
     */
    public function sanitizeCss(string $input): string
    {
        $css = self::decodeCssEscapes(str_replace("\0", "\u{FFFD}", $input));
        // Remove comments (an unterminated comment swallows the rest, like CSS does).
        $css = (string) preg_replace('/\/\*.*?(?:\*\/|$)/s', '', $css);
        // External style sheets are never loaded.
        $css = (string) preg_replace('/@import\b[^;{}]*(?:;|$)/i', '', $css);

        // url(...) through the resource URL policy; kept URLs become placeholders.
        $kept = [];
        $css = (string) preg_replace_callback(
            '/url\(\s*(?:"([^"]*)"|\'([^\']*)\'|([^)"\'\s]*))\s*\)/iu',
            function (array $m) use (&$kept): string {
                $raw = implode('', \array_slice($m, 1));
                $url = $this->resolveResourceUrl($raw);
                if ($url === null) {
                    return 'none';
                }
                $kept[] = self::cssUrl($url);

                return "\0" . (\count($kept) - 1) . "\0";
            },
            $css,
        );
        // Anything url-like left over is neutralized.
        $css = (string) preg_replace('/url\s*\(/i', 'blocked(', $css);
        $css = (string) preg_replace_callback(
            self::BLOCKED_CSS_FUNCTION_RE,
            static fn(array $m): string => 'blocked-' . preg_replace('/[^a-z-]/i', '', $m[0]) . '(',
            $css,
        );
        $css = (string) preg_replace('/(?<![\w-])(behavior|-moz-binding)\s*:/i', 'blocked-$1:', $css);
        $css = (string) preg_replace('/javascript\s*:/i', 'blocked:', $css);
        $css = (string) preg_replace('/@namespace\b/i', '@blocked-namespace', $css);
        // A backslash left after decoding would start a new escape in the browser: keep it literal.
        $css = str_replace('\\', '\\\\', $css);
        // `<` would let raw <style> text end the element.
        $css = str_replace('<', '\\3c ', $css);

        return (string) preg_replace_callback('/\x00(\d+)\x00/', static fn(array $m): string => $kept[(int) $m[1]] ?? 'none', $css);
    }
}
