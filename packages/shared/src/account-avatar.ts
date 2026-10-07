/**
 * Account bar (#120): initials and a deterministic color per account, and
 * the reordering of accounts by drag and drop. The palette is our own
 * (no brand colors); every color keeps white initials readable (WCAG AA,
 * contrast >= 4.5:1) on light and dark backgrounds alike.
 *
 * Kept free of DOM access so native clients can share the rules.
 */

/** Background colors of the account icons; white text on each is AA. */
export const ACCOUNT_COLORS = [
  '#1d5fbf', // blue
  '#0f766e', // teal
  '#7c3aed', // violet
  '#b4234a', // raspberry
  '#9a4d0b', // amber brown
  '#3f6212', // olive
  '#4338ca', // indigo
  '#a21caf', // magenta
] as const

/**
 * Up to two letters for an icon: first letters of the first two words of
 * the display name ("Martin Schmidt" -> "MS"), else the first two letters
 * of a single word ("Privat" -> "PR"); without a name the local part of
 * the address is used.
 */
export function accountInitials(displayName: string, emailAddress = ''): string {
  const source = displayName.trim() || emailAddress.split('@')[0] || ''
  const words = source.split(/[\s._+-]+/u).filter((w) => /[\p{L}\p{N}]/u.test(w))
  const firstChar = (word: string) => [...word.replace(/[^\p{L}\p{N}]/gu, '')][0] ?? ''
  const initials =
    words.length >= 2
      ? firstChar(words[0]!) + firstChar(words[1]!)
      : [...(words[0] ?? '').replace(/[^\p{L}\p{N}]/gu, '')].slice(0, 2).join('')
  return initials.toLocaleUpperCase('de-DE') || '?'
}

/** Stable color of an account, derived from its id (FNV-1a hash). */
export function accountColor(accountId: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < accountId.length; i++) {
    hash ^= accountId.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return ACCOUNT_COLORS[hash % ACCOUNT_COLORS.length]!
}

/** WCAG contrast ratio of two #rrggbb colors. */
export function contrastRatio(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!
  }
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

/**
 * Moves `movedId` to the position of `targetId` (drag and drop) and
 * returns the new order of ids; unknown ids leave the order unchanged.
 */
export function reorderIds(ids: string[], movedId: string, targetId: string): string[] {
  const from = ids.indexOf(movedId)
  const to = ids.indexOf(targetId)
  if (from < 0 || to < 0 || from === to) return [...ids]
  const next = [...ids]
  next.splice(from, 1)
  next.splice(to, 0, movedId)
  return next
}

/** Moves an id one step up (-1) or down (+1), for keyboard reordering. */
export function moveId(ids: string[], id: string, step: -1 | 1): string[] {
  const from = ids.indexOf(id)
  const to = from + step
  if (from < 0 || to < 0 || to >= ids.length) return [...ids]
  return reorderIds(ids, id, ids[to]!)
}

/**
 * Sort orders to save after reordering: position i gets sortOrder i; only
 * accounts whose stored value differs are returned (one PATCH each).
 */
export function sortOrderUpdates(
  orderedIds: string[],
  current: { id: string; sortOrder?: number }[],
): { id: string; sortOrder: number }[] {
  const stored = new Map(current.map((a) => [a.id, a.sortOrder]))
  return orderedIds
    .map((id, index) => ({ id, sortOrder: index }))
    .filter(({ id, sortOrder }) => stored.has(id) && stored.get(id) !== sortOrder)
}
