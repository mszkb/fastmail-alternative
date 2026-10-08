/**
 * Keyboard shortcuts (#115): the familiar single-key layout of web mail
 * clients - j/k to move, Enter/o to open, Esc/u back, e/y archive, # delete,
 * r/a/f reply/reply all/forward, c compose, / search, s/! flag,
 * Shift+I/Shift+U read/unread, "g" + letter to jump to a folder, ? for the
 * overview, 1-9 switch accounts. One table drives the matcher and the help.
 *
 * The matcher is free of DOM access: the app passes key events in (only
 * when the user is not typing and shortcuts are on) and gets an action back.
 */

export type ShortcutAction =
  | 'next'
  | 'previous'
  | 'open'
  | 'back'
  | 'archive'
  | 'delete'
  | 'reply'
  | 'replyAll'
  | 'forward'
  | 'compose'
  | 'search'
  | 'flag'
  | 'markRead'
  | 'markUnread'
  | 'select'
  | 'help'
  | 'goInbox'
  | 'goArchive'
  | 'goSent'
  | 'goDrafts'
  | 'goTrash'
  | 'goJunk'

export interface ShortcutDefinition {
  /** Keys as KeyboardEvent.key; "g i" is a sequence of two keys. */
  keys: string[]
  action: ShortcutAction
  label: string
  group: 'Navigation' | 'Nachricht' | 'Ordner' | 'Allgemein'
}

export const SHORTCUTS: ShortcutDefinition[] = [
  { keys: ['j'], action: 'next', label: 'Nächste Nachricht', group: 'Navigation' },
  { keys: ['k'], action: 'previous', label: 'Vorherige Nachricht', group: 'Navigation' },
  { keys: ['Enter', 'o'], action: 'open', label: 'Öffnen', group: 'Navigation' },
  { keys: ['Escape', 'u'], action: 'back', label: 'Zurück zur Liste', group: 'Navigation' },
  { keys: ['r'], action: 'reply', label: 'Antworten', group: 'Nachricht' },
  { keys: ['a'], action: 'replyAll', label: 'Allen antworten', group: 'Nachricht' },
  { keys: ['f'], action: 'forward', label: 'Weiterleiten', group: 'Nachricht' },
  { keys: ['e', 'y'], action: 'archive', label: 'Archivieren', group: 'Nachricht' },
  { keys: ['#', 'Delete'], action: 'delete', label: 'Löschen', group: 'Nachricht' },
  {
    keys: ['s', '!'],
    action: 'flag',
    label: 'Markieren / Markierung entfernen',
    group: 'Nachricht',
  },
  { keys: ['I'], action: 'markRead', label: 'Als gelesen markieren', group: 'Nachricht' },
  { keys: ['U'], action: 'markUnread', label: 'Als ungelesen markieren', group: 'Nachricht' },
  { keys: ['x'], action: 'select', label: 'Auswählen (Mehrfachauswahl)', group: 'Nachricht' },
  { keys: ['g i'], action: 'goInbox', label: 'Posteingang', group: 'Ordner' },
  { keys: ['g a'], action: 'goArchive', label: 'Archiv', group: 'Ordner' },
  { keys: ['g s'], action: 'goSent', label: 'Gesendet', group: 'Ordner' },
  { keys: ['g d'], action: 'goDrafts', label: 'Entwürfe', group: 'Ordner' },
  { keys: ['g t'], action: 'goTrash', label: 'Papierkorb', group: 'Ordner' },
  { keys: ['g j'], action: 'goJunk', label: 'Spam', group: 'Ordner' },
  { keys: ['c'], action: 'compose', label: 'Neue E-Mail', group: 'Allgemein' },
  { keys: ['/'], action: 'search', label: 'Suche', group: 'Allgemein' },
  { keys: ['?'], action: 'help', label: 'Diese Übersicht', group: 'Allgemein' },
]

/** Folder role of a "g" shortcut. */
export const GO_TO_ROLE: Partial<Record<ShortcutAction, string>> = {
  goInbox: 'inbox',
  goArchive: 'archive',
  goSent: 'sent',
  goDrafts: 'drafts',
  goTrash: 'trash',
  goJunk: 'junk',
}

/** Display form of a key in the overview ("Shift+I", "Esc", "g dann i"). */
export function shortcutLabel(key: string): string {
  if (key.includes(' ')) return key.split(' ').map(shortcutLabel).join(' dann ')
  if (key === 'Escape') return 'Esc'
  if (key === 'Delete') return 'Entf'
  if (key === 'Enter') return 'Enter'
  if (/^[A-Z]$/.test(key)) return `Shift+${key}`
  return key
}

export interface KeyInput {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
}

/**
 * Turns key presses into actions. A key that starts a sequence ("g")
 * returns 'pending'; the second key must follow within `timeoutMs`.
 * Keys with Ctrl/Cmd/Alt never match (browser and system shortcuts).
 */
export class ShortcutMatcher {
  private pending: { key: string; at: number } | null = null
  private readonly table = new Map<string, ShortcutAction>()
  private readonly prefixes = new Set<string>()

  constructor(
    private readonly timeoutMs = 1500,
    private readonly now: () => number = () => Date.now(),
    definitions: ShortcutDefinition[] = SHORTCUTS,
  ) {
    for (const definition of definitions) {
      for (const key of definition.keys) {
        this.table.set(key, definition.action)
        if (key.includes(' ')) this.prefixes.add(key.split(' ')[0]!)
      }
    }
  }

  handle(input: KeyInput): ShortcutAction | 'pending' | null {
    if (input.ctrlKey || input.metaKey || input.altKey) {
      this.pending = null
      return null
    }
    const key = input.key
    if (this.pending && this.now() - this.pending.at <= this.timeoutMs) {
      const first = this.pending.key
      this.pending = null
      return this.table.get(`${first} ${key}`) ?? null
    }
    this.pending = null
    if (this.prefixes.has(key)) {
      this.pending = { key, at: this.now() }
      return 'pending'
    }
    return this.table.get(key) ?? null
  }

  reset(): void {
    this.pending = null
  }
}

/**
 * Index of the message the cursor moves to with j/k: next/previous of the
 * current one, the first one without a current one; stays in range.
 */
export function moveCursor(ids: string[], current: string, step: 1 | -1): string | null {
  if (ids.length === 0) return null
  const index = ids.indexOf(current)
  if (index < 0) return ids[0]!
  return ids[Math.min(ids.length - 1, Math.max(0, index + step))]!
}
