/**
 * Sanitizer for HTML mail bodies (roadmap 2.9).
 *
 * The output is rendered by the web client in a sandboxed iframe (no
 * scripts, no same-origin) with its own CSP; this sanitizer is the first of
 * those layers and must be safe on its own:
 *
 * - Strict tag/attribute allowlist via sanitize-html: no script, iframe,
 *   object/embed, form controls, meta/base/link, svg/math, no event handlers.
 *   The output is fully re-serialized (text and attribute values escaped),
 *   so parser differentials can only drop content, never inject markup -
 *   except for raw <style> text, which sanitizeCss() handles (no `<` left).
 * - Every URL goes through a single policy (resolveResourceUrl / safeHref):
 *   links only http(s)/mailto, resources only data:image/* (inline images,
 *   incl. cid: references resolved to data URLs by the caller) and - only
 *   when remote content is allowed - absolute http(s) URLs.
 * - Remote resources (img src, background, CSS url()) are dropped by
 *   default and reported via remoteContentBlocked, so the client can offer
 *   to load them. srcset, @import and similar are always dropped.
 */
import sanitizeHtml from 'sanitize-html'

export interface SanitizeOptions {
  /** Keep absolute http(s) image/background URLs (user opted in). */
  allowRemote: boolean
  /** Content-ID (without angle brackets, lowercase) -> data: URL of an inline image part. */
  inlineImages?: Map<string, string>
}

export interface SanitizeResult {
  html: string
  /** True when remote resources were removed that `allowRemote` would keep. */
  remoteContentBlocked: boolean
}

/** Inline data URLs above this size are dropped (protects the client). */
export const MAX_DATA_URL_LENGTH = 5 * 1024 * 1024

const ALLOWED_TAGS = [
  'a',
  'abbr',
  'address',
  'article',
  'aside',
  'b',
  'bdi',
  'bdo',
  'big',
  'blockquote',
  'br',
  'caption',
  'center',
  'cite',
  'code',
  'col',
  'colgroup',
  'dd',
  'del',
  'details',
  'dfn',
  'div',
  'dl',
  'dt',
  'em',
  'figcaption',
  'figure',
  'font',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'i',
  'img',
  'ins',
  'kbd',
  'li',
  'main',
  'mark',
  'nav',
  'ol',
  'p',
  'pre',
  'q',
  's',
  'samp',
  'section',
  'small',
  'span',
  'strike',
  'strong',
  'style',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'time',
  'tr',
  'tt',
  'u',
  'ul',
  'var',
  'wbr',
]

/** Disallowed tags whose content is dropped as well (not rendered as text). */
const NON_TEXT_TAGS = [
  'script',
  'textarea',
  'option',
  'select',
  'xmp',
  'title',
  'noscript',
  'noembed',
  'noframes',
  'iframe',
  'template',
  'svg',
  'math',
  'object',
  'embed',
  'applet',
]

const TABLE_ATTRS = ['align', 'valign', 'bgcolor', 'background', 'width', 'height']
const ALLOWED_ATTRIBUTES: Record<string, string[]> = {
  '*': ['style', 'class', 'title', 'dir', 'lang', 'align', 'valign'],
  a: ['href'],
  img: ['src', 'alt', 'width', 'height', 'border', 'hspace', 'vspace'],
  font: ['color', 'face', 'size'],
  ol: ['start', 'type', 'reversed'],
  ul: ['type'],
  li: ['value'],
  table: [...TABLE_ATTRS, 'border', 'cellpadding', 'cellspacing', 'summary', 'frame', 'rules'],
  tr: TABLE_ATTRS,
  td: [...TABLE_ATTRS, 'colspan', 'rowspan', 'nowrap', 'scope', 'headers'],
  th: [...TABLE_ATTRS, 'colspan', 'rowspan', 'nowrap', 'scope', 'headers', 'abbr'],
  tbody: TABLE_ATTRS,
  thead: TABLE_ATTRS,
  tfoot: TABLE_ATTRS,
  col: ['span', 'width', 'align', 'valign'],
  colgroup: ['span', 'width', 'align', 'valign'],
  div: ['bgcolor'],
  hr: ['size', 'width', 'noshade', 'color'],
  time: ['datetime'],
  details: ['open'],
  blockquote: ['cite'],
  q: ['cite'],
  del: ['cite', 'datetime'],
  ins: ['cite', 'datetime'],
  bdo: ['dir'],
}

/** Inline images: raster formats only (no SVG, which may carry scripts/links). */
const DATA_IMAGE_RE = /^data:image\/(?:png|gif|jpe?g|webp|bmp|avif);base64,[a-z0-9+/=\s]*$/i
const COLOR_RE = /^#?[0-9a-z]{1,20}$/i

/**
 * CSS functions that can load resources without url() (image-set strings,
 * element references) or execute code in legacy engines. Neutralized by
 * renaming, which makes the declaration invalid (ignored by the browser).
 */
const BLOCKED_CSS_FUNCTION_RE =
  /(?<![\w-])(?:-webkit-|-moz-)?(?:image-set|image|cross-fade|element|paint|expression|src)\s*\(/gi

/** Mutable state of one sanitize run. */
interface Context {
  allowRemote: boolean
  inlineImages: Map<string, string>
  remoteBlocked: boolean
}

/**
 * Browsers strip leading/trailing C0 controls and spaces and remove
 * tab/newline anywhere in URLs - do the same before deciding.
 */
function normalizeUrl(raw: string): string {
  return raw.replace(/[\t\n\r]/g, '').replace(/^[\u0000- ]+|[\u0000- ]+$/g, '')
}

/** Absolute http(s) URL (protocol-relative counts as https) or null. */
function parseHttpUrl(value: string): URL | null {
  const candidate = value.startsWith('//') ? `https:${value}` : value
  try {
    const url = new URL(candidate)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

/**
 * URL policy for resources (img src, background, CSS url()). Returns the
 * URL to keep or null to drop it. Remote URLs set ctx.remoteBlocked when
 * dropped.
 */
function resolveResourceUrl(ctx: Context, raw: string): string | null {
  const value = normalizeUrl(raw)
  const lower = value.toLowerCase()
  if (lower.startsWith('cid:')) {
    let cid = value.slice(4)
    try {
      cid = decodeURIComponent(cid)
    } catch {
      // keep as is
    }
    return ctx.inlineImages.get(cid.replace(/^<|>$/g, '').toLowerCase()) ?? null
  }
  if (lower.startsWith('data:')) {
    return value.length <= MAX_DATA_URL_LENGTH && DATA_IMAGE_RE.test(value) ? value : null
  }
  const url = parseHttpUrl(value)
  if (!url) return null // relative, javascript:, file:, ... never loaded
  if (!ctx.allowRemote) {
    ctx.remoteBlocked = true
    return null
  }
  return url.href
}

/** Link policy: absolute http(s) and mailto only. */
function safeHref(raw: string): string | null {
  const value = normalizeUrl(raw)
  const http = parseHttpUrl(value)
  if (http) return http.href
  try {
    const url = new URL(value)
    if (url.protocol === 'mailto:') return url.href
  } catch {
    // not an absolute URL
  }
  return null
}

/** Decodes CSS escapes (`\75 rl`, `\u`) so filtering sees what the browser sees. */
function decodeCssEscapes(css: string): string {
  return css.replace(
    /\\(?:([0-9a-f]{1,6})[ \t\n\r\f]?|(\r\n|[\n\r\f])|([\s\S]))/gi,
    (_m, hex, newline, char) => {
      if (newline !== undefined) return ''
      if (char !== undefined) return char as string
      const code = parseInt(hex as string, 16)
      if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\ufffd'
      return String.fromCodePoint(code)
    },
  )
}

/** Quotes a URL for CSS url("..."): characters that could end the token are percent-encoded. */
function cssUrl(url: string): string {
  return `url("${url.replace(/["'()\\\s<>]/g, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`)}")`
}

/**
 * Sanitizes a style sheet or an inline style declaration list. Lossy for
 * exotic CSS (escapes are decoded, comments removed) but never lets a
 * resource URL through that the URL policy rejects, and never emits `<`
 * (so raw <style> text cannot close the element and inject markup).
 */
export function sanitizeCss(input: string, ctx: Context): string {
  let css = decodeCssEscapes(input.replace(/\u0000/g, '\ufffd'))
  // Remove comments (an unterminated comment swallows the rest, like CSS does).
  css = css.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, '')
  // External style sheets are never loaded.
  css = css.replace(/@import\b[^;{}]*(?:;|$)/gi, '')

  // url(...) through the resource URL policy; kept URLs become placeholders
  // so the residual checks below do not see (and reject) them.
  const kept: string[] = []
  css = css.replace(
    /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]*))\s*\)/gi,
    (_m, dq?: string, sq?: string, bare?: string) => {
      const url = resolveResourceUrl(ctx, dq ?? sq ?? bare ?? '')
      if (url === null) return 'none'
      kept.push(cssUrl(url))
      return `\u0000${kept.length - 1}\u0000`
    },
  )
  // Anything url-like left over (malformed url( tokens, image-set strings,
  // expression(), ...) is neutralized.
  css = css.replace(/url\s*\(/gi, 'blocked(')
  css = css.replace(
    BLOCKED_CSS_FUNCTION_RE,
    (match: string) => `blocked-${match.replace(/[^a-z-]/gi, '')}(`,
  )
  css = css.replace(/(?<![\w-])(behavior|-moz-binding)\s*:/gi, 'blocked-$1:')
  css = css.replace(/javascript\s*:/gi, 'blocked:')
  css = css.replace(/@namespace\b/gi, '@blocked-namespace')
  // A backslash left after decoding (from `\\`) would start a new escape
  // in the browser (`\\75 rl(` -> `url(`): keep it literal.
  css = css.replace(/\\/g, '\\\\')
  // `<` would let raw <style> text end the element; `>` is a valid
  // combinator and harmless.
  css = css.replace(/</g, '\\3c ')
  return css.replace(/\u0000(\d+)\u0000/g, (_m, index: string) => kept[Number(index)] ?? 'none')
}

/** Applies the policies to the attributes of one element (sanitize-html transformTags). */
function transformAttributes(
  ctx: Context,
  tagName: string,
  attribs: sanitizeHtml.Attributes,
): sanitizeHtml.Attributes {
  const out: sanitizeHtml.Attributes = {}
  for (const [name, value] of Object.entries(attribs)) {
    const key = name.toLowerCase()
    if (key === 'style') {
      const style = sanitizeCss(value, ctx).trim()
      if (style) out.style = style
    } else if (key === 'src' || key === 'background') {
      const url = resolveResourceUrl(ctx, value)
      if (url) out[key] = url
    } else if (key === 'href') {
      const href = safeHref(value)
      if (href) out.href = href
    } else if (key === 'bgcolor' || key === 'color') {
      if (COLOR_RE.test(value.trim())) out[key] = value.trim()
    } else {
      out[key] = value
    }
  }
  if (tagName === 'a') {
    out.target = '_blank'
    out.rel = 'noopener noreferrer nofollow'
  }
  if (tagName === 'img') out.referrerpolicy = 'no-referrer'
  // <style> carries no attributes, so the raw-text rewrite below always
  // matches it (and media/type attributes are not needed).
  if (tagName === 'style') return {}
  return out
}

/** Sanitizes an HTML mail body (fragment or full document). */
export function sanitizeMailHtml(html: string, options: SanitizeOptions): SanitizeResult {
  const ctx: Context = {
    allowRemote: options.allowRemote,
    inlineImages: options.inlineImages ?? new Map(),
    remoteBlocked: false,
  }

  const sanitized = sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    // <style> is allowed on purpose: its raw text is rewritten by
    // sanitizeCss() below (no `<`, URL policy applied).
    allowVulnerableTags: true,
    nonTextTags: NON_TEXT_TAGS,
    allowedAttributes: {
      ...ALLOWED_ATTRIBUTES,
      a: [...ALLOWED_ATTRIBUTES.a!, 'target', 'rel'],
      img: [...ALLOWED_ATTRIBUTES.img!, 'referrerpolicy'],
      // body is rewritten to a div (see transformTags)
      div: [...ALLOWED_ATTRIBUTES.div!],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['http', 'https', 'data'] },
    allowedSchemesAppliedToAttributes: ['href', 'src', 'background', 'cite'],
    allowProtocolRelative: false,
    // Style attributes are filtered by sanitizeCss (transformTags), not by
    // sanitize-html's postcss-based allowlist.
    parseStyleAttributes: false,
    disallowedTagsMode: 'discard',
    nestingLimit: 100,
    transformTags: {
      // Keep the body's colors: a div carries them inside the fragment.
      // ('*' below runs afterwards and sanitizes the merged style.)
      body: (_tag, attribs): sanitizeHtml.Tag => {
        const style: string[] = []
        const bgcolor = attribs.bgcolor?.trim()
        if (bgcolor && COLOR_RE.test(bgcolor)) style.push(`background-color: ${bgcolor}`)
        if (attribs.style) style.push(attribs.style)
        return {
          tagName: 'div',
          attribs: style.length > 0 ? { style: style.join('; ') } : ({} as sanitizeHtml.Attributes),
        }
      },
      '*': (tagName, attribs) => ({
        tagName,
        attribs: transformAttributes(ctx, tagName, attribs),
      }),
    },
  })

  // Raw <style> text is emitted as-is by sanitize-html; rewrite it. Text and
  // attribute values are escaped in the output, so a literal `<style>` here
  // is always a real element.
  const result = sanitized.replace(
    /<style\b[^>]*>([\s\S]*?)<\/style>/gi,
    (_m, css: string) => `<style>${sanitizeCss(css, ctx)}</style>`,
  )
  return { html: result, remoteContentBlocked: ctx.remoteBlocked }
}
