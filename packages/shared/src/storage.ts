import { formatByteSize } from './attachments'

/**
 * Storage usage per account (roadmap 5.4): numbers only, never content or
 * file names. `messageBytes` is the provider size (IMAP RFC822.SIZE) of the
 * messages whose raw source is stored in the mail-data volume - the
 * encrypted file is slightly larger, so clients show it as approximate.
 */
export interface AccountStorage {
  accountId: string
  /** All synced messages of the account (with or without stored body). */
  messageCount: number
  /** Messages whose encrypted raw source is stored in the volume. */
  storedMessageCount: number
  /** Approximate bytes of the stored raw messages (provider size). */
  messageBytes: number
  /** Pending uploads (compose, drafts, outbox) stored in the database. */
  uploadCount: number
  uploadBytes: number
  /** messageBytes + uploadBytes. */
  totalBytes: number
}

/** Response of `GET /api/storage`: all accounts of the user plus the sum. */
export interface StorageResponse {
  accounts: AccountStorage[]
  totalBytes: number
}

const countFormat = new Intl.NumberFormat('de-DE')

/**
 * German one-line summary for the settings, e.g.
 * "ca. 1,4 MB · 1.234 Nachrichten · 2 Anhänge (500 B) ausstehend".
 * Message bytes are the provider size, hence "ca.".
 */
export function storageSummary(storage: AccountStorage): string {
  const parts = [
    `ca. ${formatByteSize(storage.totalBytes)}`,
    `${countFormat.format(storage.messageCount)} ${storage.messageCount === 1 ? 'Nachricht' : 'Nachrichten'}`,
  ]
  if (storage.uploadCount > 0) {
    parts.push(
      `${countFormat.format(storage.uploadCount)} ${storage.uploadCount === 1 ? 'Anhang' : 'Anhänge'} (${formatByteSize(storage.uploadBytes)}) ausstehend`,
    )
  }
  return parts.join(' · ')
}
