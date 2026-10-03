/**
 * Integration tests for message actions (roadmap 2.4): validation,
 * ownership (404 for foreign ids), optimistic local changes (flags, moved
 * and removed locations) and the enqueued write-back job. Requires
 * DATABASE_URL; skipped when unset.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { runMigrations } from '@fma/db/migrate'
import {
  encryptField,
  generateDataKey,
  loadMasterKey,
  messageFieldAad,
  wrapDataKey,
} from '@fma/crypto'
import type { FolderSummary, MessageActionJobPayload, MessageListItem } from '@fma/shared'
import { buildApp } from '../src/app'
import { pool } from '../src/db'

process.env.MASTER_KEY ??= randomBytes(32).toString('base64')

const databaseUrl = process.env.DATABASE_URL
const TABLES =
  'session, device, "user", mail_account, identity, folder, job, message, message_location, message_body'

let app: FastifyInstance
let authToken: string
let uidCounter = 1

async function createAccount(userId: string): Promise<{ id: string; dek: Buffer }> {
  const id = randomUUID()
  const dek = generateDataKey()
  const wrapped = wrapDataKey(loadMasterKey(process.env.MASTER_KEY!), dek, 'v1')
  await pool.query(
    `INSERT INTO mail_account
       (id, user_id, display_name, email_address, imap_host, imap_port,
        smtp_host, smtp_port, wrapped_dek, key_id, credential_enc, status)
     VALUES ($1, $2, 'Test', $3, 'imap.test', 993, 'smtp.test', 465, $4, 'v1', $5, 'ok')`,
    [
      id,
      userId,
      `${id}@example.com`,
      Buffer.from(wrapped, 'utf8'),
      Buffer.from(encryptField(dek, '{}', `mail_account.credential:${id}`), 'utf8'),
    ],
  )
  return { id, dek }
}

async function createFolder(
  accountId: string,
  path: string,
  specialUse: string | null = null,
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO folder (account_id, path, delimiter, special_use, uidvalidity)
     VALUES ($1, $2, '/', $3, 7) RETURNING id`,
    [accountId, path, specialUse],
  )
  return rows[0]!.id
}

async function createMessage(
  account: { id: string; dek: Buffer },
  folderId: string,
  flags: string[] = [],
): Promise<string> {
  const id = randomUUID()
  const enc = (field: Parameters<typeof messageFieldAad>[0], value: string) =>
    Buffer.from(encryptField(account.dek, value, messageFieldAad(field, id)), 'utf8')
  await pool.query(
    `INSERT INTO message
       (id, account_id, message_id_header, subject_enc, from_enc, recipients_enc,
        snippet_enc, sent_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
    [
      id,
      account.id,
      `<${id}@test>`,
      enc('subject', 'Subject'),
      enc('from', '[]'),
      enc('recipients', '{}'),
      enc('snippet', ''),
    ],
  )
  await pool.query(
    `INSERT INTO message_location (message_id, folder_id, uidvalidity, uid, flags)
     VALUES ($1, $2, 7, $3, $4)`,
    [id, folderId, uidCounter++, flags],
  )
  return id
}

async function action(body: Record<string, unknown>, token: string | null = authToken) {
  return app.inject({
    method: 'POST',
    url: '/api/messages/actions',
    payload: body,
    headers: token ? { cookie: `fma_session=${token}` } : {},
  })
}

async function locationsOf(messageId: string) {
  const { rows } = await pool.query<{ folder_id: string; uid: string; flags: string[] }>(
    'SELECT folder_id::text, uid::text, flags FROM message_location WHERE message_id = $1',
    [messageId],
  )
  return rows
}

async function jobs(): Promise<{ account_id: string; payload: MessageActionJobPayload }[]> {
  const { rows } = await pool.query(
    `SELECT account_id::text, payload FROM job WHERE type = 'message_action' ORDER BY id`,
  )
  return rows
}

describe.skipIf(!databaseUrl)('message actions api', () => {
  let account: { id: string; dek: Buffer }
  let inboxId: string
  let trashId: string
  let otherId: string
  let foreignFolderId: string
  let foreignMessageId: string

  beforeAll(async () => {
    app = buildApp({ logger: false })
    await runMigrations(pool)
    await pool.query(`TRUNCATE ${TABLES} CASCADE`)

    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { email: 'actions@example.com', password: 'correct horse battery' },
    })
    authToken = setup.cookies.find((c) => c.name === 'fma_session')!.value
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM "user"')
    account = await createAccount(rows[0]!.id)
    inboxId = await createFolder(account.id, 'INBOX', 'inbox')
    trashId = await createFolder(account.id, 'Trash', 'trash')
    otherId = await createFolder(account.id, 'Projects')

    const other = await pool.query<{ id: string }>(
      `INSERT INTO "user" (email, password_hash) VALUES ('other@example.com', 'x') RETURNING id`,
    )
    const foreign = await createAccount(other.rows[0]!.id)
    foreignFolderId = await createFolder(foreign.id, 'INBOX', 'inbox')
    foreignMessageId = await createMessage(foreign, foreignFolderId)
  })

  beforeEach(async () => {
    await pool.query('DELETE FROM job')
  })

  afterAll(async () => {
    await pool.query(`TRUNCATE ${TABLES} CASCADE`)
    await pool.end()
  })

  it('requires authentication', async () => {
    const id = await createMessage(account, inboxId)
    const res = await action({ folderId: inboxId, messageIds: [id], action: 'read' }, null)
    expect(res.statusCode).toBe(401)
  })

  it('rejects malformed requests with 400', async () => {
    const id = await createMessage(account, inboxId)
    for (const body of [
      {},
      { folderId: inboxId, messageIds: [id], action: 'explode' },
      { folderId: inboxId, messageIds: [], action: 'read' },
      { folderId: inboxId, messageIds: ['nope'], action: 'read' },
      { folderId: 'nope', messageIds: [id], action: 'read' },
      { folderId: inboxId, messageIds: [id], action: 'move' },
      {
        folderId: inboxId,
        messageIds: Array.from({ length: 101 }, () => randomUUID()),
        action: 'read',
      },
      { folderId: inboxId, messageIds: [id], action: 'move', targetFolderId: inboxId },
    ]) {
      const res = await action(body)
      expect(res.statusCode, JSON.stringify(body).slice(0, 80)).toBe(400)
      expect(res.json().message).toBeTruthy()
    }
    expect(await jobs()).toEqual([])
  })

  it('answers 404 for foreign or unknown folders, messages and targets', async () => {
    const own = await createMessage(account, inboxId)
    const inOtherFolder = await createMessage(account, otherId)
    for (const body of [
      { folderId: foreignFolderId, messageIds: [foreignMessageId], action: 'read' },
      { folderId: inboxId, messageIds: [foreignMessageId], action: 'read' },
      { folderId: inboxId, messageIds: [own, randomUUID()], action: 'read' },
      { folderId: inboxId, messageIds: [inOtherFolder], action: 'read' },
      { folderId: randomUUID(), messageIds: [own], action: 'read' },
      { folderId: inboxId, messageIds: [own], action: 'move', targetFolderId: foreignFolderId },
    ]) {
      const res = await action(body)
      expect(res.statusCode, JSON.stringify(body)).toBe(404)
    }
    // Nothing changed, nothing queued.
    expect((await locationsOf(own))[0]!.flags).toEqual([])
    expect((await locationsOf(foreignMessageId))[0]!.flags).toEqual([])
    expect(await jobs()).toEqual([])
  })

  it('marks read/unread and flags locally and enqueues the write-back', async () => {
    const a = await createMessage(account, inboxId)
    const b = await createMessage(account, inboxId, ['\\Flagged'])

    const res = await action({ folderId: inboxId, messageIds: [a, b], action: 'read' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ updated: 2 })
    expect((await locationsOf(a))[0]!.flags).toEqual(['\\Seen'])
    expect((await locationsOf(b))[0]!.flags.sort()).toEqual(['\\Flagged', '\\Seen'])

    const [job] = await jobs()
    expect(job!.account_id).toBe(account.id)
    expect(job!.payload).toMatchObject({ operation: 'read', folderId: inboxId, uidvalidity: '7' })
    expect(job!.payload.items.map((item) => item.messageId).sort()).toEqual([a, b].sort())
    expect(job!.payload.items.every((item) => item.uid > 0)).toBe(true)

    // Idempotent: reading again does not duplicate the flag.
    await action({ folderId: inboxId, messageIds: [a], action: 'read' })
    expect((await locationsOf(a))[0]!.flags).toEqual(['\\Seen'])

    await action({ folderId: inboxId, messageIds: [a], action: 'unread' })
    await action({ folderId: inboxId, messageIds: [a], action: 'flag' })
    await action({ folderId: inboxId, messageIds: [b], action: 'unflag' })
    expect((await locationsOf(a))[0]!.flags).toEqual(['\\Flagged'])
    expect((await locationsOf(b))[0]!.flags).toEqual(['\\Seen'])
    expect((await jobs()).map((j) => j.payload.operation)).toEqual([
      'read',
      'read',
      'unread',
      'flag',
      'unflag',
    ])

    // Detail and folder counts reflect the change immediately.
    const detail = await app.inject({
      method: 'GET',
      url: `/api/messages/${a}`,
      headers: { cookie: `fma_session=${authToken}` },
    })
    expect(detail.json().flags).toMatchObject({ seen: false, flagged: true })
  })

  it('answers 409 for archive without an archive folder', async () => {
    const id = await createMessage(account, inboxId)
    const res = await action({ folderId: inboxId, messageIds: [id], action: 'archive' })
    expect(res.statusCode).toBe(409)
    expect(res.json().message).toContain('Archiv')
    expect((await locationsOf(id))[0]!.folder_id).toBe(inboxId)
    expect(await jobs()).toEqual([])
  })

  it('archives into the archive folder; the lists reflect it immediately', async () => {
    const archiveId = await createFolder(account.id, 'Archive', 'archive')
    const id = await createMessage(account, inboxId)

    const res = await action({ folderId: inboxId, messageIds: [id], action: 'archive' })
    expect(res.statusCode).toBe(200)
    const [location] = await locationsOf(id)
    expect(location!.folder_id).toBe(archiveId)
    expect(Number(location!.uid)).toBeLessThan(0) // placeholder until the job ran

    const list = async (folderId: string): Promise<MessageListItem[]> =>
      (
        await app.inject({
          method: 'GET',
          url: `/api/folders/${folderId}/messages`,
          headers: { cookie: `fma_session=${authToken}` },
        })
      ).json().messages
    expect((await list(inboxId)).map((m) => m.id)).not.toContain(id)
    expect((await list(archiveId)).map((m) => m.id)).toContain(id)

    const [job] = await jobs()
    expect(job!.payload).toMatchObject({
      operation: 'move',
      folderId: inboxId,
      targetFolderId: archiveId,
    })
    expect(job!.payload.items[0]!.uid).toBeGreaterThan(0)

    // Actions on the placeholder wait until the move is written back.
    const again = await action({ folderId: archiveId, messageIds: [id], action: 'read' })
    expect(again.statusCode).toBe(409)

    // Already archived.
    const archived = await createMessage(account, archiveId)
    const twice = await action({ folderId: archiveId, messageIds: [archived], action: 'archive' })
    expect(twice.statusCode).toBe(400)
  })

  it('moves into another folder of the same account', async () => {
    const id = await createMessage(account, inboxId, ['\\Seen'])
    const res = await action({
      folderId: inboxId,
      messageIds: [id],
      action: 'move',
      targetFolderId: otherId,
    })
    expect(res.statusCode).toBe(200)
    const [location] = await locationsOf(id)
    expect(location!.folder_id).toBe(otherId)
    expect(location!.flags).toEqual(['\\Seen'])
    expect((await jobs())[0]!.payload).toMatchObject({ operation: 'move', targetFolderId: otherId })

    const folders = await app.inject({
      method: 'GET',
      url: `/api/accounts/${account.id}/folders`,
      headers: { cookie: `fma_session=${authToken}` },
    })
    const projects = (folders.json().folders as FolderSummary[]).find((f) => f.id === otherId)
    expect(projects!.total).toBeGreaterThanOrEqual(1)
  })

  it('refuses to move into a \\Noselect container', async () => {
    const id = await createMessage(account, inboxId)
    await pool.query('UPDATE folder SET selectable = false WHERE id = $1', [otherId])
    try {
      const res = await action({
        folderId: inboxId,
        messageIds: [id],
        action: 'move',
        targetFolderId: otherId,
      })
      expect(res.statusCode).toBe(404)
      expect((await locationsOf(id))[0]!.folder_id).toBe(inboxId)
    } finally {
      await pool.query('UPDATE folder SET selectable = true WHERE id = $1', [otherId])
    }
  })

  it('deletes into Trash, and permanently inside Trash', async () => {
    const id = await createMessage(account, inboxId)
    const res = await action({ folderId: inboxId, messageIds: [id], action: 'delete' })
    expect(res.statusCode).toBe(200)
    expect((await locationsOf(id))[0]!.folder_id).toBe(trashId)
    expect((await jobs())[0]!.payload).toMatchObject({
      operation: 'move',
      targetFolderId: trashId,
    })

    const trashed = await createMessage(account, trashId)
    await pool.query('DELETE FROM job')
    const permanent = await action({ folderId: trashId, messageIds: [trashed], action: 'delete' })
    expect(permanent.statusCode).toBe(200)
    expect(await locationsOf(trashed)).toEqual([])
    const [job] = await jobs()
    expect(job!.payload).toMatchObject({ operation: 'expunge', folderId: trashId })
    expect(job!.payload.items[0]!.messageId).toBe(trashed)
    expect(job!.payload.targetFolderId).toBeUndefined()
  })

  it('answers 409 for delete without a Trash folder', async () => {
    const owner = await pool.query<{ user_id: string }>(
      'SELECT user_id FROM mail_account WHERE id = $1',
      [account.id],
    )
    const second = await createAccount(owner.rows[0]!.user_id)
    const folder = await createFolder(second.id, 'INBOX', 'inbox')
    const id = await createMessage(second, folder)
    const res = await action({ folderId: folder, messageIds: [id], action: 'delete' })
    expect(res.statusCode).toBe(409)
    expect(res.json().message).toContain('Papierkorb')
  })
})
