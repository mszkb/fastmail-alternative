/**
 * Compose logic (roadmap 2.6): pure functions that prefill new messages,
 * replies, reply-alls and forwards - recipients, subject prefixes,
 * threading headers (In-Reply-To/References), quote and signature.
 *
 * Used by the web client; kept here so the rules are unit-tested and can
 * be reused by native clients' backends later.
 */
import { isValidEmailAddress, type MailPerson, type MessageDetail } from './mail'

/** `<local@domain>` without whitespace or nested brackets. */
const MESSAGE_ID_RE = /^<[^\s<>@]+@[^\s<>@]+>$/
export const MAX_MESSAGE_ID_LENGTH = 250
/** References kept in a reply: the thread root plus the newest ones. */
export const MAX_REPLY_REFERENCES = 20

/** Message-ID as accepted by `POST /api/outbox` (In-Reply-To/References). */
export function isValidMessageId(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length <= MAX_MESSAGE_ID_LENGTH && MESSAGE_ID_RE.test(value)
  )
}

/** Sender address of the account as offered in the compose form. */
export interface ComposeIdentity {
  id: string
  name: string
  emailAddress: string
  /** Plain-text signature without the "-- " delimiter; null/empty = none. */
  signature: string | null
  /**
   * Default identity of the account (chosen in the settings, else the one
   * matching the account address); used when nothing else fits.
   */
  isDefault: boolean
}

/** `GET /api/accounts/:id/identities` */
export interface IdentityListResponse {
  identities: ComposeIdentity[]
}

/** `POST /api/accounts/:id/identities` (roadmap 3.6) */
export interface CreateIdentityRequest {
  name: string
  emailAddress: string
  signature?: string | null
}

/** `PATCH /api/identities/:id` - every field optional; isDefault only `true`. */
export interface UpdateIdentityRequest {
  name?: string
  signature?: string | null
  isDefault?: true
}

export const MAX_SIGNATURE_LENGTH = 10_000
export const MAX_IDENTITY_NAME_LENGTH = 100
export const MAX_IDENTITIES_PER_ACCOUNT = 20

export type ComposeMode = 'new' | 'reply' | 'replyAll' | 'forward'

/** Prefilled compose form (maps 1:1 onto `SendMessageRequest`). */
export interface ComposeDraft {
  mode: ComposeMode
  identityId: string | null
  to: MailPerson[]
  cc: MailPerson[]
  bcc: MailPerson[]
  subject: string
  text: string
  inReplyTo?: string
  references?: string[]
}

/** Original message fields needed for replies and forwards. */
export type ComposeOriginal = Pick<
  MessageDetail,
  'subject' | 'from' | 'to' | 'cc' | 'replyTo' | 'date' | 'text' | 'messageId' | 'references'
> &
  Partial<Pick<MessageDetail, 'deliveredTo'>>

// Reply prefixes in common languages/clients: Re, Aw/Antw (German), Sv
// (Nordic), optionally with a counter like "Re[2]:" or "Re(2):".
const REPLY_PREFIX_RE = /^\s*(?:re|aw|antw|sv)\s*(?:\[\d+\]|\(\d+\))?\s*:\s*/i
// Forward prefixes: Fwd, Fw, WG (German "Weitergeleitet").
const FORWARD_PREFIX_RE = /^\s*(?:fwd?|wg)\s*(?:\[\d+\]|\(\d+\))?\s*:\s*/i

function stripPrefixes(subject: string, re: RegExp): string {
  let rest = subject.replace(/\s*[\r\n]+\s*/g, ' ').trim()
  for (;;) {
    const next = rest.replace(re, '')
    if (next === rest) return rest
    rest = next
  }
}

/** True when the subject starts with a reply prefix (Re:, AW:, Sv:, ...). */
export function hasReplyPrefix(subject: string): boolean {
  return REPLY_PREFIX_RE.test(subject)
}

/**
 * Subject without any (interleaved) reply/forward prefixes and with
 * collapsed whitespace: "Re: AW: Fwd: Termin" -> "Termin".
 */
export function baseSubject(subject: string): string {
  let rest = subject.replace(/\s+/g, ' ').trim()
  for (;;) {
    const next = stripPrefixes(stripPrefixes(rest, REPLY_PREFIX_RE), FORWARD_PREFIX_RE)
    if (next === rest) return rest
    rest = next
  }
}

/** "Re: " exactly once; existing reply prefixes collapse, forward prefixes stay. */
export function replySubject(subject: string): string {
  return `Re: ${stripPrefixes(subject, REPLY_PREFIX_RE)}`.trimEnd()
}

/** "Fwd: " exactly once; existing forward prefixes collapse, reply prefixes stay. */
export function forwardSubject(subject: string): string {
  return `Fwd: ${stripPrefixes(subject, FORWARD_PREFIX_RE)}`.trimEnd()
}

/**
 * References of a reply (RFC 5322 3.6.4): the original's References plus
 * its Message-ID, without invalid or duplicate ids. Long chains keep the
 * thread root and the newest ids (at most MAX_REPLY_REFERENCES).
 */
export function replyReferences(
  original: Pick<ComposeOriginal, 'messageId' | 'references'>,
): string[] {
  const seen = new Set<string>()
  const refs: string[] = []
  for (const ref of [...original.references, original.messageId]) {
    if (!isValidMessageId(ref) || seen.has(ref)) continue
    seen.add(ref)
    refs.push(ref)
  }
  if (refs.length <= MAX_REPLY_REFERENCES) return refs
  return [refs[0]!, ...refs.slice(refs.length - (MAX_REPLY_REFERENCES - 1))]
}

/** Removes own addresses and duplicates (case-insensitive), keeping order. */
function filterPeople(people: MailPerson[], exclude: Set<string>): MailPerson[] {
  const result: MailPerson[] = []
  for (const person of people) {
    const key = person.address.trim().toLowerCase()
    if (!key || exclude.has(key)) continue
    exclude.add(key)
    result.push({ name: person.name, address: person.address.trim() })
  }
  return result
}

/**
 * Recipients of a reply. Reply: Reply-To, else From. Reply all: that plus
 * the original To in "To", the original Cc in "Cc" - without the account's
 * own addresses (all identities) and duplicates.
 *
 * Replying to an own message (e.g. from "Sent") goes to its original
 * recipients instead of oneself.
 */
export function replyRecipients(
  original: Pick<ComposeOriginal, 'from' | 'to' | 'cc' | 'replyTo'>,
  ownAddresses: string[],
  all: boolean,
): { to: MailPerson[]; cc: MailPerson[] } {
  const own = new Set(ownAddresses.map((address) => address.trim().toLowerCase()))
  const isOwn = (person: MailPerson): boolean => own.has(person.address.trim().toLowerCase())

  const author =
    original.replyTo.length > 0 ? original.replyTo : original.from ? [original.from] : []
  const fromSelf = author.length > 0 && author.every(isOwn)
  const primary = fromSelf ? original.to : author

  if (!all) {
    // A plain reply to an own message: original To even if that is oneself
    // (note to self); otherwise never reply to own addresses.
    const to = filterPeople(primary, fromSelf ? new Set() : new Set(own))
    return { to: to.length > 0 ? to : filterPeople(author, new Set()), cc: [] }
  }

  const exclude = new Set(own)
  const to = filterPeople([...primary, ...(fromSelf ? [] : original.to)], exclude)
  const cc = filterPeople(original.cc, exclude)
  // Nobody left in To (e.g. only own addresses there): promote Cc.
  if (to.length === 0) return { to: cc, cc: [] }
  return { to, cc }
}

/** "Name <address>" or just the address. */
export function formatPerson(person: MailPerson): string {
  return person.name ? `${person.name} <${person.address}>` : person.address
}

/** Date as shown in quote headers, e.g. "03.10.2026 um 14:05". */
export function formatQuoteDate(iso: string, timeZone?: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const day = new Intl.DateTimeFormat('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone,
  }).format(date)
  const time = new Intl.DateTimeFormat('de-DE', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  }).format(date)
  return `${day} um ${time}`
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

/** Prefixes every line with "> " ("> >" style for nested quotes, ">" for empty lines). */
export function quoteLines(text: string): string {
  const body = normalizeNewlines(text).replace(/\s+$/, '')
  if (!body) return ''
  return body
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n')
}

/** "Am <date> schrieb <name>:" + the quoted original text. */
export function quoteMessage(
  original: Pick<ComposeOriginal, 'from' | 'date' | 'text'>,
  timeZone?: string,
): string {
  const date = formatQuoteDate(original.date, timeZone)
  const author = original.from ? formatPerson(original.from) : 'Unbekannt'
  const header = date ? `Am ${date} schrieb ${author}:` : `${author} schrieb:`
  const quoted = quoteLines(original.text ?? '')
  return quoted ? `${header}\n${quoted}` : header
}

/** Signature block with the standard "-- " delimiter; empty without a signature. */
export function signatureBlock(signature: string | null | undefined): string {
  const text = normalizeNewlines(signature ?? '')
    .replace(/^\s*\n/, '')
    .replace(/\s+$/, '')
  if (!text.trim()) return ''
  // Signature that already starts with the delimiter (with or without the space).
  const withoutDelimiter = text.replace(/^--[ \t]*\n/, '')
  return `-- \n${withoutDelimiter}`
}

/** Header block of a forwarded message (German labels), followed by its text. */
export function forwardBlock(
  original: Pick<ComposeOriginal, 'from' | 'to' | 'cc' | 'date' | 'subject' | 'text'>,
  timeZone?: string,
): string {
  const lines = ['-------- Weitergeleitete Nachricht --------']
  lines.push(`Von: ${original.from ? formatPerson(original.from) : 'Unbekannt'}`)
  const date = formatQuoteDate(original.date, timeZone)
  if (date) lines.push(`Datum: ${date}`)
  lines.push(`Betreff: ${original.subject}`)
  if (original.to.length > 0) lines.push(`An: ${original.to.map(formatPerson).join(', ')}`)
  if (original.cc.length > 0) lines.push(`Cc: ${original.cc.map(formatPerson).join(', ')}`)
  const text = normalizeNewlines(original.text ?? '').replace(/\s+$/, '')
  return text ? `${lines.join('\n')}\n\n${text}` : lines.join('\n')
}

/**
 * Body layout: empty lines for the own text at the top, then the signature,
 * then the quote/forwarded message (signature above the quote).
 */
function composeBody(signature: string | null | undefined, tail: string): string {
  const parts = [signatureBlock(signature), tail].filter(Boolean)
  return parts.length === 0 ? '' : `\n\n${parts.join('\n\n')}`
}

/**
 * Identity to send from (roadmap 3.6): for replies/forwards the identity
 * the original was addressed to - To/Cc first (in header order), then the
 * envelope recipient (Delivered-To/X-Original-To, e.g. Bcc or mailing
 * lists) - compared case-insensitively; otherwise the default (or first)
 * identity.
 */
export function pickIdentity(
  identities: ComposeIdentity[],
  original?: Pick<ComposeOriginal, 'to' | 'cc' | 'deliveredTo'>,
): ComposeIdentity | null {
  if (original) {
    const byAddress = new Map<string, ComposeIdentity>()
    for (const identity of identities) {
      const key = identity.emailAddress.trim().toLowerCase()
      if (!byAddress.has(key)) byAddress.set(key, identity)
    }
    const candidates = [
      ...[...original.to, ...original.cc].map((person) => person.address),
      ...(original.deliveredTo ?? []),
    ]
    for (const address of candidates) {
      const match = byAddress.get(address.trim().toLowerCase())
      if (match) return match
    }
  }
  return identities.find((identity) => identity.isDefault) ?? identities[0] ?? null
}

/** Prefilled compose form for a new message, reply, reply all or forward. */
export function createDraft(
  mode: ComposeMode,
  identities: ComposeIdentity[],
  original?: ComposeOriginal,
  timeZone?: string,
): ComposeDraft {
  const identity = pickIdentity(identities, mode === 'new' ? undefined : original)
  const base: ComposeDraft = {
    mode,
    identityId: identity?.id ?? null,
    to: [],
    cc: [],
    bcc: [],
    subject: '',
    text: composeBody(identity?.signature, ''),
  }
  if (mode === 'new' || !original) return { ...base, mode: 'new' }

  if (mode === 'forward') {
    // No In-Reply-To: a forward starts a new conversation; References keep
    // the link to the forwarded message for clients that thread by it.
    const references = replyReferences(original)
    return {
      ...base,
      subject: forwardSubject(original.subject),
      text: composeBody(identity?.signature, forwardBlock(original, timeZone)),
      ...(references.length > 0 ? { references } : {}),
    }
  }

  const own = identities.map((entry) => entry.emailAddress)
  const { to, cc } = replyRecipients(original, own, mode === 'replyAll')
  const references = replyReferences(original)
  return {
    ...base,
    to,
    cc,
    subject: replySubject(original.subject),
    text: composeBody(identity?.signature, quoteMessage(original, timeZone)),
    ...(isValidMessageId(original.messageId) ? { inReplyTo: original.messageId } : {}),
    ...(references.length > 0 ? { references } : {}),
  }
}

/** Quotes a display name when it contains characters with a meaning in address lists. */
function formatListEntry(person: MailPerson): string {
  if (!person.name) return person.address
  const name = /[",;<>@()[\]:\\]/.test(person.name)
    ? `"${person.name.replace(/(["\\])/g, '\\$1')}"`
    : person.name
  return `${name} <${person.address}>`
}

/** Recipients as editable text: `Name <a@b.c>, "Doe, John" <j@d.e>`. */
export function formatAddressList(people: MailPerson[]): string {
  return people.map(formatListEntry).join(', ')
}

/** Splits at commas/semicolons outside of quotes and angle brackets. */
function splitAddressList(input: string): string[] {
  const parts: string[] = []
  let current = ''
  let quoted = false
  let angle = false
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!
    if (quoted && char === '\\' && i + 1 < input.length) {
      current += char + input[i + 1]
      i++
      continue
    }
    if (char === '"') quoted = !quoted
    else if (!quoted && char === '<') angle = true
    else if (!quoted && char === '>') angle = false
    if (!quoted && !angle && (char === ',' || char === ';')) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  parts.push(current)
  return parts.map((part) => part.trim()).filter(Boolean)
}

/**
 * Parses a recipient field ("a@b.c, Name <d@e.f>; "Doe, John" <j@x.y>").
 * Returns the valid people and the entries that are not valid addresses
 * (validated with the same check as the API).
 */
export function parseAddressList(input: string): { people: MailPerson[]; invalid: string[] } {
  const people: MailPerson[] = []
  const invalid: string[] = []
  for (const entry of splitAddressList(input)) {
    const match = /^(.*?)\s*<([^<>]*)>$/.exec(entry)
    let name = ''
    let address = entry
    if (match) {
      name = match[1]!.trim()
      address = match[2]!.trim()
      if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) {
        name = name.slice(1, -1).replace(/\\(.)/g, '$1')
      }
    }
    if (isValidEmailAddress(address)) people.push({ name, address })
    else invalid.push(entry)
  }
  return { people, invalid }
}
