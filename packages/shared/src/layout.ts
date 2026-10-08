/**
 * Mail layout (#113): where the reading pane sits (right of the list,
 * below it, or off - then a message replaces the list) and the widths of
 * the folder column and the list, dragged by the user. Per device.
 */

export type ReadingPane = 'right' | 'bottom' | 'off'

export const READING_PANE_CHOICES: { value: ReadingPane; label: string }[] = [
  { value: 'right', label: 'Lesebereich rechts' },
  { value: 'bottom', label: 'Lesebereich unten' },
  { value: 'off', label: 'Ohne Lesebereich' },
]

export interface MailLayout {
  readingPane: ReadingPane
  /** Folder column width in px. */
  folderWidth: number
  /** List width (pane right) in px. */
  listWidth: number
  /** List height (pane below) in px. */
  listHeight: number
}

export const LAYOUT_LIMITS = {
  folderWidth: { min: 160, max: 400, default: 224 },
  listWidth: { min: 260, max: 720, default: 400 },
  listHeight: { min: 160, max: 900, default: 320 },
} as const

export function clampLayoutSize(key: keyof typeof LAYOUT_LIMITS, value: unknown): number {
  const limits = LAYOUT_LIMITS[key]
  const number = typeof value === 'number' && Number.isFinite(value) ? value : limits.default
  return Math.round(Math.min(limits.max, Math.max(limits.min, number)))
}

/** Stored layout (JSON or anything else) with safe defaults. */
export function parseLayout(raw: unknown): MailLayout {
  let value: Record<string, unknown> = {}
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') value = parsed as Record<string, unknown>
    } catch {
      value = {}
    }
  }
  const pane = value.readingPane
  return {
    readingPane: pane === 'bottom' || pane === 'off' ? pane : 'right',
    folderWidth: clampLayoutSize('folderWidth', value.folderWidth),
    listWidth: clampLayoutSize('listWidth', value.listWidth),
    listHeight: clampLayoutSize('listHeight', value.listHeight),
  }
}
