/**
 * App badge (roadmap 4.4): the unread count shown on the app icon (Badging
 * API) or, where that is not visible, as a prefix of the document title,
 * e.g. "(3) Mail". The service worker sets the same count from the push
 * payload (`badge`), the app whenever the account list refreshes.
 *
 * Pure functions, shared by web and later native clients (ADR-0010).
 */

/** Largest number shown literally; more becomes "999+". */
export const MAX_BADGE_DISPLAY = 999

/** Unread INBOX messages over all accounts (same count as the push badge). */
export function unreadBadgeCount(accounts: readonly { unreadCount: number }[]): number {
  let total = 0
  for (const account of accounts) {
    const count = account.unreadCount
    if (Number.isFinite(count) && count > 0) total += Math.floor(count)
  }
  return total
}

/** Short label for a count: "" for none, "999+" above the limit. */
export function formatBadgeLabel(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return ''
  return count > MAX_BADGE_DISPLAY ? `${MAX_BADGE_DISPLAY}+` : String(Math.floor(count))
}

const TITLE_PREFIX_RE = /^\(\d+\+?\) /

/** Title with the unread prefix ("(3) Mail"); an existing prefix is replaced. */
export function formatBadgeTitle(title: string, count: number): string {
  const base = title.replace(TITLE_PREFIX_RE, '')
  const label = formatBadgeLabel(count)
  return label ? `(${label}) ${base}` : base
}
