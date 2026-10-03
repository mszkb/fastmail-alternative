/**
 * Folder roles per account (roadmap 3.3): which IMAP folder is Sent,
 * Drafts, Trash, Archive or Junk. Shared by the worker (folder_sync) and
 * the api (manual override), so both resolve roles identically.
 *
 * - Detection: RFC 6154 SPECIAL-USE attributes first; only for roles no
 *   folder announces via attribute, well-known German/English folder names
 *   are used (providers without SPECIAL-USE, e.g. older Exchange/IMAP
 *   servers: "Gesendete Objekte", "Papierkorb", "Junk-E-Mail" ...).
 * - Resolution: a manual override always wins; every role is assigned to
 *   at most one folder per account and every folder has at most one role.
 */

/** Roles a user may assign manually (INBOX is fixed by IMAP). */
export const FOLDER_ROLES = ['sent', 'drafts', 'trash', 'archive', 'junk'] as const
export type FolderRole = (typeof FOLDER_ROLES)[number]
export type SpecialUse = FolderRole | 'inbox'

export const FOLDER_ROLE_LABELS: Record<FolderRole, string> = {
  sent: 'Gesendet',
  drafts: 'Entwürfe',
  trash: 'Papierkorb',
  archive: 'Archiv',
  junk: 'Spam',
}

export function isFolderRole(value: unknown): value is FolderRole {
  return typeof value === 'string' && (FOLDER_ROLES as readonly string[]).includes(value)
}

/** Lower-cased, NFC-normalized folder names (last path segment) per role. */
const ROLE_NAMES: Record<FolderRole, string[]> = {
  sent: [
    'sent',
    'sent items',
    'sent mail',
    'sent messages',
    'gesendet',
    'gesendete objekte',
    'gesendete elemente',
    'gesendete nachrichten',
  ],
  drafts: ['drafts', 'draft', 'entwürfe', 'entwurf'],
  trash: [
    'trash',
    'deleted',
    'deleted items',
    'deleted messages',
    'bin',
    'papierkorb',
    'gelöschte elemente',
    'gelöschte objekte',
    'gelöschte nachrichten',
  ],
  archive: ['archive', 'archives', 'archiv'],
  junk: ['junk', 'spam', 'junk e-mail', 'junk-e-mail', 'junk email', 'junk mail', 'bulk mail'],
}

const NAME_TO_ROLE = new Map<string, FolderRole>(
  FOLDER_ROLES.flatMap((role) => ROLE_NAMES[role].map((name) => [name, role] as const)),
)

export interface ListedFolder {
  path: string
  delimiter?: string | null
  /** RFC 6154 attribute as listed by IMAP, e.g. "\\Sent". */
  specialUseAttribute?: string | null
}

function attributeRole(attribute: string | null | undefined): SpecialUse | null {
  if (!attribute?.startsWith('\\')) return null
  const value = attribute.slice(1).toLowerCase()
  if (value === 'inbox') return 'inbox'
  return isFolderRole(value) ? value : null
}

/** Last segment of an IMAP path ("INBOX.Sent" -> "Sent", "[Gmail]/Spam" -> "Spam"). */
function folderName(path: string, delimiter?: string | null): string {
  const index = delimiter ? path.lastIndexOf(delimiter) : -1
  return index >= 0 ? path.slice(index + delimiter!.length) : path
}

/** Role guessed from the folder name only; null for unknown names. */
export function roleFromName(path: string, delimiter?: string | null): FolderRole | null {
  const name = folderName(path, delimiter).normalize('NFC').trim().toLowerCase()
  return NAME_TO_ROLE.get(name) ?? null
}

/**
 * Detected role per path (may contain duplicates; resolveFolderRoles picks
 * one). Name heuristics only apply to roles no folder announces via
 * SPECIAL-USE, so a stray "Gesendet" folder does not compete with \Sent.
 */
export function detectFolderRoles(folders: ListedFolder[]): Map<string, SpecialUse | null> {
  const byAttribute = new Map<string, SpecialUse | null>()
  const announced = new Set<SpecialUse>()
  for (const folder of folders) {
    const role =
      folder.path.toUpperCase() === 'INBOX' ? 'inbox' : attributeRole(folder.specialUseAttribute)
    byAttribute.set(folder.path, role)
    if (role) announced.add(role)
  }
  const result = new Map<string, SpecialUse | null>()
  for (const folder of folders) {
    let role = byAttribute.get(folder.path) ?? null
    if (!role) {
      const guessed = roleFromName(folder.path, folder.delimiter)
      if (guessed && !announced.has(guessed)) role = guessed
    }
    result.set(folder.path, role)
  }
  return result
}

export interface StoredFolderRole {
  path: string
  /** Role from the last folder_sync (attribute or name heuristic). */
  detected: string | null
  /** Manual choice of the user (roadmap 3.3); wins over detection. */
  override: string | null
}

/** Prefer top-level/shorter paths, then alphabetical (deterministic). */
function compareCandidates(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)
}

/**
 * Effective role per path: overrides first, then detected roles for the
 * remaining roles and folders. Exactly one folder per role at most.
 */
export function resolveFolderRoles(folders: StoredFolderRole[]): Map<string, SpecialUse | null> {
  const result = new Map<string, SpecialUse | null>(folders.map((f) => [f.path, null]))
  const taken = new Set<string>()
  const sorted = [...folders].sort((a, b) => compareCandidates(a.path, b.path))

  const inbox = sorted.find((f) => f.path.toUpperCase() === 'INBOX')
  if (inbox) {
    result.set(inbox.path, 'inbox')
    taken.add('inbox')
  }

  for (const folder of sorted) {
    if (result.get(folder.path) || !isFolderRole(folder.override)) continue
    if (taken.has(folder.override)) continue
    result.set(folder.path, folder.override)
    taken.add(folder.override)
  }

  for (const folder of sorted) {
    if (result.get(folder.path) || isFolderRole(folder.override)) continue
    if (!isFolderRole(folder.detected) || taken.has(folder.detected)) continue
    result.set(folder.path, folder.detected)
    taken.add(folder.detected)
  }
  return result
}

/** `PATCH /api/folders/:id` - null returns the folder to automatic detection. */
export interface UpdateFolderRequest {
  specialUse: FolderRole | null
}
