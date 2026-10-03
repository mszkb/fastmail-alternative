/**
 * folder_sync job (roadmap 2.2 step 1): lists the IMAP mailboxes of an
 * account and upserts them into the folder table, including per-folder sync
 * state (uidvalidity, uidnext, highestmodseq) and RFC 6154 special-use flags.
 *
 * Idempotent: re-running updates rows in place; folders that vanished on the
 * server are removed.
 */
import { ImapFlow } from 'imapflow'
import type { Pool } from '@fma/db'
import { loadAccountContext } from '../accounts'
import { closeOnJobAbort } from '../job-context'
import { mailTestMode } from '../ports'

const KNOWN_SPECIAL_USE = new Set(['inbox', 'sent', 'drafts', 'trash', 'archive', 'junk'])

/** RFC 6154 attribute ("\Sent") -> enum value ("sent"); INBOX heuristic. */
function normalizeSpecialUse(path: string, specialUse?: string | false): string | null {
  if (typeof specialUse === 'string' && specialUse.startsWith('\\')) {
    const value = specialUse.slice(1).toLowerCase()
    if (KNOWN_SPECIAL_USE.has(value)) return value
  }
  if (path.toUpperCase() === 'INBOX') return 'inbox'
  return null
}

interface ListedMailbox {
  path: string
  delimiter?: string
  specialUse?: string | false
}

export async function runFolderSync(pool: Pool, accountId: string): Promise<void> {
  const { imap: credentials } = await loadAccountContext(
    pool,
    accountId,
    process.env.MASTER_KEY ?? '',
  )

  const client = new ImapFlow({
    host: credentials.host,
    port: credentials.port,
    secure: credentials.secure,
    auth: { user: credentials.user, pass: credentials.password },
    logger: false,
    greetingTimeout: 15_000,
    tls: mailTestMode() ? { rejectUnauthorized: false } : undefined,
    ...(mailTestMode() ? { doSTARTTLS: false as const } : {}),
  })

  const unregister = closeOnJobAbort(() => client.close())
  try {
    await client.connect()
    const mailboxes = (await client.list()) as unknown as ListedMailbox[]

    for (const mailbox of mailboxes) {
      // Per-folder status: uidnext/uidvalidity/unread counts.
      let uidnext: string | null = null
      let uidvalidity: string | null = null
      let unread: number | null = null
      const status = await client.status(mailbox.path, {
        uidNext: true,
        uidValidity: true,
        unseen: true,
      })
      if (status) {
        uidnext = status.uidNext != null ? String(status.uidNext) : null
        uidvalidity = status.uidValidity != null ? String(status.uidValidity) : null
        unread = status.unseen ?? null
      }

      await pool.query(
        `INSERT INTO folder
           (account_id, path, delimiter, special_use, uidvalidity, uidnext, unread_count, last_synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())
         ON CONFLICT (account_id, path) DO UPDATE SET
           delimiter = EXCLUDED.delimiter,
           special_use = EXCLUDED.special_use,
           uidvalidity = EXCLUDED.uidvalidity,
           uidnext = EXCLUDED.uidnext,
           unread_count = EXCLUDED.unread_count,
           last_synced_at = now()`,
        [
          accountId,
          mailbox.path,
          mailbox.delimiter ?? null,
          normalizeSpecialUse(mailbox.path, mailbox.specialUse),
          uidvalidity,
          uidnext,
          unread,
        ],
      )
    }

    // Remove folders that no longer exist on the server.
    const paths = mailboxes.map((mailbox) => mailbox.path)
    await pool.query(`DELETE FROM folder WHERE account_id = $1 AND path <> ALL($2)`, [
      accountId,
      paths,
    ])
  } finally {
    unregister()
    client.close()
  }
}
