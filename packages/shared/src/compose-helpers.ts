/**
 * Composer helpers (#116): recipient suggestions from known addresses and
 * the undo-send window.
 *
 * - Suggestions: the last, unfinished entry of a recipient field ("An",
 *   "Cc", "Bcc" are comma lists) is matched against names and addresses the
 *   client already knows (loaded messages, identities); choosing one
 *   replaces that entry. No server-side contact store (principle 9).
 * - Undo send: the client waits the chosen seconds before it submits to the
 *   outbox; "Rückgängig" in that window returns to editing. Nothing reaches
 *   the server before, so nothing has to be cancelled there.
 */
import type { MailPerson } from './mail'

export const UNDO_SEND_CHOICES = [0, 5, 10, 20, 30] as const
export type UndoSendSeconds = (typeof UNDO_SEND_CHOICES)[number]

export function parseUndoSendSeconds(value: unknown): UndoSendSeconds {
  if (value === null || value === undefined || value === '') return 5
  const number = Number(value)
  return (UNDO_SEND_CHOICES as readonly number[]).includes(number) ? (number as UndoSendSeconds) : 5
}

/** Index of the last comma/semicolon outside a quoted name (-1: none). */
function lastSeparator(field: string): number {
  let quoted = false
  let index = -1
  for (let i = 0; i < field.length; i++) {
    const char = field[i]
    if (char === '"') quoted = !quoted
    else if (!quoted && (char === ',' || char === ';')) index = i
  }
  return index
}

/** The entry being typed: text after the last separator, without quotes. */
export function currentRecipientToken(field: string): string {
  return field
    .slice(lastSeparator(field) + 1)
    .replace(/"/g, '')
    .trim()
}

/** Distinct people by address (case-insensitive), the first name wins. */
export function uniquePeople(people: (MailPerson | null | undefined)[]): MailPerson[] {
  const seen = new Map<string, MailPerson>()
  for (const person of people) {
    if (!person?.address) continue
    const key = person.address.toLowerCase()
    const known = seen.get(key)
    if (!known) seen.set(key, person)
    else if (!known.name && person.name) seen.set(key, person)
  }
  return [...seen.values()]
}

/**
 * Suggestions for the entry being typed (at least 2 characters), matching
 * the start of the address or of a word in the name; addresses already in
 * the field are left out.
 */
export function suggestRecipients(field: string, known: MailPerson[], limit = 6): MailPerson[] {
  const token = currentRecipientToken(field).toLowerCase()
  if (token.length < 2) return []
  const present = new Set(
    field
      .toLowerCase()
      .split(/[,;]/)
      .slice(0, -1)
      .map((entry) => entry.match(/[^\s<>"]+@[^\s<>"]+/)?.[0] ?? ''),
  )
  return known
    .filter((person) => !present.has(person.address.toLowerCase()))
    .filter(
      (person) =>
        person.address.toLowerCase().startsWith(token) ||
        person.name.toLowerCase().startsWith(token) ||
        person.name
          .toLowerCase()
          .split(/\s+/)
          .some((word) => word.startsWith(token)),
    )
    .slice(0, limit)
}

/** "Name <address>" (quoted if needed) or the bare address. */
export function formatRecipient(person: MailPerson): string {
  if (!person.name) return person.address
  const name = /[",;<>@()]/.test(person.name) ? `"${person.name.replace(/"/g, '')}"` : person.name
  return `${name} <${person.address}>`
}

/** Replaces the entry being typed with the chosen person, ready for the next. */
export function applyRecipientSuggestion(field: string, person: MailPerson): string {
  const index = lastSeparator(field)
  const head = index >= 0 ? `${field.slice(0, index + 1).trimEnd()} ` : ''
  return `${head}${formatRecipient(person)}, `
}
