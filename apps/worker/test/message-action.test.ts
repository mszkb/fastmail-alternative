/**
 * Integration tests for the message_action job (roadmap 2.4). Requires
 * DATABASE_URL + GreenMail.
 *
 * Each test emulates the API's optimistic local change (flags, move
 * placeholder, removed location) and runs the write-back job, then checks
 * the IMAP server state and that the next message_sync converges instead
 * of reverting the change.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import nodemailer from 'nodemailer'
import { ImapFlow } from 'imapflow'
import { runMigrations } from '@fma/db/migrate'
import { encryptField, generateDataKey, loadMasterKey, wrapDataKey } from '@fma/crypto'
import type { MessageActionJobPayload } from '@fma/shared'
import { runFolderSync } from '../src/jobs/folder-sync'
import { runMessageAction } from '../src/jobs/message-action'
import { runMessageSync } from '../src/jobs/message-sync'

process.env.MASTER_KEY ??= randomBytes(32).toString('base64')

const databaseUrl = process.env.DATABASE_URL
const greenmailHost = process.env.GREENMAIL_HOST
const greenmailUser = process.env.GREENMAIL_USER ?? ''
const greenmailPassword = process.env.GREENMAIL_PASSWORD ?? ''

const TABLES =
  'session, device, "user", mail_account, identity, folder, job, message, message_location, message_body'
const MOVED = 'FmaActionMoved'
const TRASH = 'FmaActionTrash'

function imapClient(): ImapFlow {
  return new ImapFlow({
    host: greenmailHost!,
    port: Number(process.env.GREENMAIL_IMAP_PORT),
    secure: false,
    auth: { user: greenmailUser, pass: greenmailPassword },
    logger: false,
    tls: { rejectUnauthorized: false },
    doSTARTTLS: false,
  })
}

/** Runs fn with `mailbox` selected on GreenMail. */
async function withMailbox<T>(mailbox: string, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = imapClient()
  await client.connect()
  const lock = await client.getMailboxLock(mailbox)
  try {
    return await fn(client)
  } finally {
    lock.release()
    await client.logout().catch(() => client.close())
  }
}

/** Server-side UID -> flags of a mailbox. */
async function serverMessages(mailbox: string): Promise<Map<number, string[]>> {
  return withMailbox(mailbox, async (client) => {
    const result = new Map<number, string[]>()
    const status = (client as unknown as { mailbox?: { exists?: number } }).mailbox
    if ((status?.exists ?? 0) === 0) return result
    for await (const msg of client.fetch('1:*', { uid: true, flags: true })) {
      result.set(msg.uid, [...(msg.flags ?? [])])
    }
    return result
  })
}

describe.skipIf(!databaseUrl || !greenmailHost)('message_action job', () => {
  let pool: pg.Pool
  let accountId: string
  let mailDataDir: string
  const folders: Record<string, string> = {}

  interface Location {
    id: string
    message_id: string
    uidvalidity: string
    uid: string
    flags: string[]
  }

  async function locations(folderId: string): Promise<Location[]> {
    const { rows } = await pool.query<Location>(
      `SELECT id, message_id::text, uidvalidity::text, uid::text, flags
       FROM message_location WHERE folder_id = $1 ORDER BY uid`,
      [folderId],
    )
    return rows
  }

  function payload(
    operation: MessageActionJobPayload['operation'],
    folderId: string,
    rows: Location[],
    extra: Partial<MessageActionJobPayload> = {},
  ): Record<string, unknown> {
    const value: MessageActionJobPayload = {
      operation,
      folderId,
      uidvalidity: rows[0]!.uidvalidity,
      items: rows.map((row) => ({
        uid: Number(row.uid),
        locationId: row.id,
        messageId: row.message_id,
      })),
      ...extra,
    }
    return value as unknown as Record<string, unknown>
  }

  /** Emulates the API's optimistic move: location becomes a placeholder. */
  async function moveLocally(rows: Location[], targetFolderId: string): Promise<void> {
    await pool.query(
      `UPDATE message_location
       SET folder_id = $2, uidvalidity = 0, uid = -nextval('message_location_placeholder_seq')
       WHERE id = ANY($1::uuid[])`,
      [rows.map((row) => row.id), targetFolderId],
    )
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl })
    await runMigrations(pool)
    await pool.query(`TRUNCATE ${TABLES} CASCADE`)
    mailDataDir = await mkdtemp(path.join(tmpdir(), 'fma-mail-data-'))
    process.env.MAIL_DATA_DIR = mailDataDir

    const user = await pool.query<{ id: string }>(
      `INSERT INTO "user" (email, password_hash) VALUES ($1, 'not-a-real-hash') RETURNING id`,
      [`action-${Date.now()}@example.com`],
    )
    accountId = randomUUID()
    const dek = generateDataKey()
    await pool.query(
      `INSERT INTO mail_account
         (id, user_id, display_name, email_address, imap_host, imap_port,
          smtp_host, smtp_port, wrapped_dek, key_id, credential_enc, status)
       VALUES ($1, $2, 'Action-Test', $3, $4, $5, 'smtp.test', 465, $6, 'v1', $7, 'ok')`,
      [
        accountId,
        user.rows[0]!.id,
        greenmailUser,
        greenmailHost,
        Number(process.env.GREENMAIL_IMAP_PORT),
        wrapDataKey(loadMasterKey(process.env.MASTER_KEY!), dek, 'v1'),
        Buffer.from(
          encryptField(
            dek,
            JSON.stringify({ imapUser: greenmailUser, imapPassword: greenmailPassword }),
            `mail_account.credential:${accountId}`,
          ),
          'utf8',
        ),
      ],
    )

    // Clean server state: empty INBOX, fresh test folders.
    const setup = imapClient()
    await setup.connect()
    for (const mailbox of [MOVED, TRASH]) {
      await setup.mailboxDelete(mailbox).catch(() => {})
      await setup.mailboxCreate(mailbox)
    }
    await setup.logout().catch(() => setup.close())
    const leftovers = [...(await serverMessages('INBOX')).keys()]
    if (leftovers.length > 0) {
      await withMailbox('INBOX', (client) => client.messageDelete(leftovers, { uid: true }))
    }

    const transporter = nodemailer.createTransport({
      host: greenmailHost,
      port: Number(process.env.GREENMAIL_SMTP_PORT),
      secure: false,
      tls: { rejectUnauthorized: false },
    })
    for (const n of [1, 2, 3, 4]) {
      await transporter.sendMail({
        from: `sender-${n}@example.com`,
        to: greenmailUser,
        subject: `Aktion ${n}`,
        text: `Aktionstest ${n}.`,
      })
    }
    transporter.close()
    const start = Date.now()
    while ((await serverMessages('INBOX')).size < 4 && Date.now() - start < 20_000) {
      await new Promise((resolve) => setTimeout(resolve, 300))
    }

    await runFolderSync(pool, accountId)
    const { rows } = await pool.query<{ id: string; path: string }>(
      'SELECT id, path FROM folder WHERE account_id = $1',
      [accountId],
    )
    for (const row of rows) folders[row.path] = row.id
    for (const mailbox of ['INBOX', MOVED, TRASH]) {
      await runMessageSync(pool, accountId, folders[mailbox]!)
    }
    expect(await locations(folders.INBOX!)).toHaveLength(4)
  })

  afterAll(async () => {
    const cleanup = imapClient()
    await cleanup.connect()
    for (const mailbox of [MOVED, TRASH]) await cleanup.mailboxDelete(mailbox).catch(() => {})
    await cleanup.logout().catch(() => cleanup.close())
    await pool.query(`TRUNCATE ${TABLES} CASCADE`)
    await pool.end()
    await rm(mailDataDir, { recursive: true, force: true }).catch(() => {})
  })

  it('writes flag changes back and the next sync keeps them', async () => {
    const [target] = await locations(folders.INBOX!)
    // Optimistic local change as the API does it.
    await pool.query(
      'UPDATE message_location SET flags = array_cat(flags, $2::text[]) WHERE id = $1',
      [target!.id, ['\\Seen', '\\Flagged']],
    )
    expect(
      await runMessageAction(pool, accountId, payload('read', folders.INBOX!, [target!])),
    ).toBe('done')
    await runMessageAction(pool, accountId, payload('flag', folders.INBOX!, [target!]))

    const server = await serverMessages('INBOX')
    expect(server.get(Number(target!.uid))).toEqual(expect.arrayContaining(['\\Seen', '\\Flagged']))

    await runMessageSync(pool, accountId, folders.INBOX!)
    const after = (await locations(folders.INBOX!)).find((row) => row.id === target!.id)!
    expect(after.flags).toEqual(expect.arrayContaining(['\\Seen', '\\Flagged']))

    // And back: unflag + unread.
    await runMessageAction(pool, accountId, payload('unflag', folders.INBOX!, [target!]))
    await runMessageAction(pool, accountId, payload('unread', folders.INBOX!, [target!]))
    const server2 = await serverMessages('INBOX')
    expect(server2.get(Number(target!.uid))).not.toContain('\\Flagged')
    expect(server2.get(Number(target!.uid))).not.toContain('\\Seen')
    const local = (await locations(folders.INBOX!)).find((row) => row.id === target!.id)!
    expect(local.flags).not.toContain('\\Seen')
    expect(local.flags).not.toContain('\\Flagged')
  })

  it('moves a message to another folder and learns its new UID', async () => {
    const [moved] = await locations(folders.INBOX!)
    await moveLocally([moved!], folders[MOVED]!)

    const outcome = await runMessageAction(
      pool,
      accountId,
      payload('move', folders.INBOX!, [moved!], { targetFolderId: folders[MOVED]! }),
    )
    expect(outcome).toBe('done')

    expect((await serverMessages('INBOX')).has(Number(moved!.uid))).toBe(false)
    const target = await serverMessages(MOVED)
    expect(target.size).toBe(1)

    // COPYUID (GreenMail has UIDPLUS): the placeholder became the real location.
    const local = await locations(folders[MOVED]!)
    expect(local).toHaveLength(1)
    expect(local[0]!.message_id).toBe(moved!.message_id)
    expect(Number(local[0]!.uid)).toBe([...target.keys()][0])

    // Follow-up syncs were enqueued and converge without duplicates.
    const { rows: jobs } = await pool.query<{ folder_id: string }>(
      `SELECT payload->>'folderId' AS folder_id FROM job
       WHERE type = 'message_sync' AND state = 'queued'`,
    )
    expect(jobs.map((job) => job.folder_id).sort()).toEqual(
      [folders.INBOX!, folders[MOVED]!].sort(),
    )
    await runMessageSync(pool, accountId, folders.INBOX!)
    await runMessageSync(pool, accountId, folders[MOVED]!)
    expect(await locations(folders.INBOX!)).toHaveLength(3)
    expect(await locations(folders[MOVED]!)).toHaveLength(1)
    const body = await pool.query('SELECT 1 FROM message_body WHERE message_id = $1', [
      moved!.message_id,
    ])
    expect(body.rowCount).toBe(1)
  })

  it('deletes to Trash, then permanently from Trash', async () => {
    const [victim] = await locations(folders.INBOX!)
    await moveLocally([victim!], folders[TRASH]!)
    await runMessageAction(
      pool,
      accountId,
      payload('move', folders.INBOX!, [victim!], { targetFolderId: folders[TRASH]! }),
    )
    expect((await serverMessages(TRASH)).size).toBe(1)
    const [inTrash] = await locations(folders[TRASH]!)
    expect(Number(inTrash!.uid)).toBeGreaterThan(0)

    const { rows: bodyRows } = await pool.query<{ storage_ref: string }>(
      'SELECT storage_ref FROM message_body WHERE message_id = $1',
      [victim!.message_id],
    )
    const bodyFile = path.join(mailDataDir, bodyRows[0]!.storage_ref)
    await access(bodyFile)

    // Permanent delete: the API removed the location already.
    await pool.query('DELETE FROM message_location WHERE id = $1', [inTrash!.id])
    await runMessageAction(pool, accountId, payload('expunge', folders[TRASH]!, [inTrash!]))

    expect((await serverMessages(TRASH)).size).toBe(0)
    const message = await pool.query('SELECT 1 FROM message WHERE id = $1', [victim!.message_id])
    expect(message.rowCount).toBe(0)
    await expect(access(bodyFile)).rejects.toThrow()
  })

  it('drops the action on a UIDVALIDITY mismatch and resyncs', async () => {
    await pool.query("DELETE FROM job WHERE type = 'message_sync'")
    const [target] = await locations(folders.INBOX!)
    const before = await serverMessages('INBOX')

    const outcome = await runMessageAction(
      pool,
      accountId,
      payload('flag', folders.INBOX!, [{ ...target!, uidvalidity: '1' }]),
    )
    expect(outcome).toBe('uidvalidity_changed')
    expect(await serverMessages('INBOX')).toEqual(before)
    const { rows: jobs } = await pool.query<{ folder_id: string }>(
      `SELECT payload->>'folderId' AS folder_id FROM job WHERE type = 'message_sync'`,
    )
    expect(jobs.map((job) => job.folder_id)).toEqual([folders.INBOX!])
  })

  it('restores a message whose move was never written back', async () => {
    const [stuck] = await locations(folders.INBOX!)
    await moveLocally([stuck!], folders[MOVED]!)
    expect(await locations(folders[MOVED]!)).toHaveLength(2)

    // No message_action job pending: the target sync drops the placeholder,
    // the source sync fetches the message again (server truth).
    await runMessageSync(pool, accountId, folders[MOVED]!)
    expect(await locations(folders[MOVED]!)).toHaveLength(1)
    await runMessageSync(pool, accountId, folders.INBOX!)
    const inbox = await locations(folders.INBOX!)
    expect(inbox.map((row) => Number(row.uid))).toContain(Number(stuck!.uid))
  })
})
