/**
 * folder_sync job (roadmap 2.2 step 1): lists the IMAP mailboxes of an
 * account and upserts them into the folder table, including per-folder
 * status (uidnext, unread count) and RFC 6154 special-use flags. The
 * folder's uidvalidity is written by message_sync only.
 *
 * Folder roles (roadmap 3.3): the detected role (SPECIAL-USE attribute, else
 * German/English name heuristic) goes to special_use_detected; the
 * effective special_use is resolved together with the user's manual
 * override (never touched here), one folder per role (@fma/shared).
 *
 * Idempotent: re-running updates rows in place; folders that vanished on the
 * server are removed.
 */
import { ImapFlow } from 'imapflow'
import type { Pool, PoolClient } from '@fma/db'
import { detectFolderRoles, resolveFolderRoles } from '@fma/shared'
import { loadAccountContext } from '../accounts'
import { closeOnJobAbort } from '../job-context'
import { assertMailHost, mailTestMode } from '../ports'

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
    await assertMailHost(credentials.host)
    await client.connect()
    const mailboxes = (await client.list()) as unknown as ListedMailbox[]
    const detected = detectFolderRoles(
      mailboxes.map((mailbox) => ({
        path: mailbox.path,
        delimiter: mailbox.delimiter,
        specialUseAttribute: mailbox.specialUse || null,
      })),
    )

    for (const mailbox of mailboxes) {
      // Per-folder status: uidnext/unread counts. uidvalidity is NOT stored
      // here: folder.uidvalidity is the one message_sync synced the
      // locations with, so it can detect a change (it is the only writer).
      let uidnext: string | null = null
      let unread: number | null = null
      const status = await client.status(mailbox.path, {
        uidNext: true,
        unseen: true,
      })
      if (status) {
        uidnext = status.uidNext != null ? String(status.uidNext) : null
        unread = status.unseen ?? null
      }

      await pool.query(
        `INSERT INTO folder
           (account_id, path, delimiter, special_use_detected, uidnext,
            unread_count, last_synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (account_id, path) DO UPDATE SET
           delimiter = EXCLUDED.delimiter,
           special_use_detected = EXCLUDED.special_use_detected,
           uidnext = EXCLUDED.uidnext,
           unread_count = EXCLUDED.unread_count,
           last_synced_at = now()`,
        [
          accountId,
          mailbox.path,
          mailbox.delimiter ?? null,
          detected.get(mailbox.path) ?? null,
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
    await applyFolderRoles(pool, accountId)
  } finally {
    unregister()
    client.close()
  }
}

/**
 * Recomputes the effective special_use of all folders of the account from
 * detected roles and manual overrides (same resolver as the api's
 * PATCH /api/folders/:id). Only changed rows are written. Locks the account
 * row like the api does, so a concurrent manual change is not overwritten
 * with a stale result.
 */
async function applyFolderRoles(pool: Pool, accountId: string): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT 1 FROM mail_account WHERE id = $1 FOR UPDATE', [accountId])
    await resolveAndStore(client, accountId)
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

async function resolveAndStore(client: PoolClient, accountId: string): Promise<void> {
  const { rows } = await client.query<{
    id: string
    path: string
    special_use: string | null
    special_use_detected: string | null
    special_use_override: string | null
  }>(
    `SELECT id, path, special_use, special_use_detected, special_use_override
     FROM folder WHERE account_id = $1`,
    [accountId],
  )
  const roles = resolveFolderRoles(
    rows.map((row) => ({
      path: row.path,
      detected: row.special_use_detected,
      override: row.special_use_override,
    })),
  )
  for (const row of rows) {
    const role = roles.get(row.path) ?? null
    if (role !== row.special_use) {
      await client.query('UPDATE folder SET special_use = $2 WHERE id = $1', [row.id, role])
    }
  }
}
