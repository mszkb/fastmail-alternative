/**
 * Message list (#114): grouping by date ("Heute", "Gestern", "Diese Woche",
 * "Älter") and range selection with Shift-click. Local time of the device;
 * the week starts on Monday.
 */

export type DateGroup = 'Heute' | 'Gestern' | 'Diese Woche' | 'Älter'

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** Group of a message date relative to `now`; future dates count as today. */
export function dateGroup(iso: string, now: Date = new Date()): DateGroup {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'Älter'
  const today = startOfDay(now)
  const day = startOfDay(date)
  if (day >= today) return 'Heute'
  const yesterday = startOfDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))
  if (day >= yesterday) return 'Gestern'
  const weekday = (now.getDay() + 6) % 7 // Monday = 0
  const monday = startOfDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - weekday))
  return day >= monday ? 'Diese Woche' : 'Älter'
}

/**
 * Consecutive runs of the (newest first) list with their group label; a
 * label appears once per run, so an out-of-order list stays correct.
 */
export function groupByDate<T extends { date: string }>(
  messages: T[],
  now: Date = new Date(),
): { label: DateGroup; messages: T[] }[] {
  const groups: { label: DateGroup; messages: T[] }[] = []
  for (const message of messages) {
    const label = dateGroup(message.date, now)
    const last = groups[groups.length - 1]
    if (last && last.label === label) last.messages.push(message)
    else groups.push({ label, messages: [message] })
  }
  return groups
}

/**
 * Shift-click: all ids between the anchor (last clicked) and the target,
 * inclusive, in list order; without a known anchor just the target.
 */
export function selectRange(ids: string[], anchor: string, target: string): string[] {
  const from = ids.indexOf(anchor)
  const to = ids.indexOf(target)
  if (to < 0) return []
  if (from < 0) return [target]
  return ids.slice(Math.min(from, to), Math.max(from, to) + 1)
}
