/**
 * Server configuration export/import (roadmap 4.7): moves accounts,
 * identities and folder mappings to a new instance WITHOUT any secret.
 * Passwords/tokens are never part of the file; imported accounts wait in
 * `auth_error` (code CREDENTIALS_REQUIRED) until the user re-enters them.
 * Mail itself is not exported - it is synced again from the provider.
 */
import type { FolderRole } from './folders'

export const CONFIG_EXPORT_FORMAT = 'fma-config'
/** Bump on incompatible changes; the import accepts versions <= current. */
export const CONFIG_EXPORT_VERSION = 1

export interface ConfigExportIdentity {
  name: string
  emailAddress: string
  signature: string | null
  isDefault: boolean
}

export interface ConfigExportAccount {
  displayName: string
  emailAddress: string
  sortOrder: number
  credentialKind: 'password' | 'oauth2'
  /** Initial sync limit (ISO date) or null = everything. */
  syncSince: string | null
  /** Host, port and user name only - never a password. */
  imap: { host: string; port: number; user: string }
  smtp: { host: string; port: number; user: string }
  identities: ConfigExportIdentity[]
  /** Manual folder mapping (roadmap 3.3): role -> IMAP path. */
  folderRoles: Partial<Record<FolderRole, { path: string; delimiter: string | null }>>
}

/** `GET /api/export/config`, body of `POST /api/import/config`. */
export interface ConfigExport {
  format: typeof CONFIG_EXPORT_FORMAT
  version: number
  exportedAt: string
  accounts: ConfigExportAccount[]
  /** Reserved for server-side user settings (none yet). */
  settings: Record<string, never>
}

/** `POST /api/import/config` */
export interface ConfigImportResponse {
  /** Created accounts; all need their password before the first sync. */
  imported: string[]
  /** Email addresses skipped because an account with them already exists. */
  skipped: string[]
}
