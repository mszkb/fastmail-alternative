/**
 * Integration tests for the folder role mapping (roadmap 3.3):
 * PATCH /api/folders/:id validation, ownership, one folder per role and
 * return to automatic detection. Requires DATABASE_URL; skipped when unset.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { runMigrations } from '@fma/db/migrate'
import { encryptField, generateDataKey, loadMasterKey, wrapDataKey } from '@fma/crypto'
import type { FolderListResponse } from '@fma/shared'
import { buildApp } from '../src/app'
import { pool } from '../src/db'

process.env.MASTER_KEY ??= randomBytes(32).toString('base64')

const databaseUrl = process.env.DATABASE_URL
const TABLES = 'session, device, "user", mail_account, identity, folder, job'

let app: FastifyInstance
let authToken: string

async function createAccount(userId: string): Promise<string> {
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
  return id
}

async function createFolder(accountId: string, path: string, detected: string | null = null) {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO folder (account_id, path, delimiter, special_use, special_use_detected)
     VALUES ($1, $2, '/', $3, $3) RETURNING id`,
    [accountId, path, detected],
  )
  return rows[0]!.id
}

function patch(folderId: string, payload: unknown, token: string | null = authToken) {
  return app.inject({
    method: 'PATCH',
    url: `/api/folders/${folderId}`,
    payload: payload as Record<string, unknown>,
    headers: token ? { cookie: `fma_session=${token}` } : {},
  })
}

async function roles(accountId: string): Promise<Record<string, string | null>> {
  const res = await app.inject({
    method: 'GET',
    url: `/api/accounts/${accountId}/folders`,
    headers: { cookie: `fma_session=${authToken}` },
  })
  const body = res.json<FolderListResponse>()
  return Object.fromEntries(
    body.folders.map((f) => [f.path, f.specialUse + (f.specialUseOverride ? '*' : '')]),
  )
}

describe.skipIf(!databaseUrl)('folder role mapping api', () => {
  let accountId: string
  let inboxId: string
  let sentId: string
  let gesendetId: string
  let archivId: string
  let foreignFolderId: string

  beforeAll(async () => {
    app = buildApp({ logger: false })
    await runMigrations(pool)
    await pool.query(`TRUNCATE ${TABLES} CASCADE`)
    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { email: 'folders@example.com', password: 'correct horse battery' },
    })
    authToken = setup.cookies.find((c) => c.name === 'fma_session')!.value
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM "user"')
    accountId = await createAccount(rows[0]!.id)
    inboxId = await createFolder(accountId, 'INBOX', 'inbox')
    sentId = await createFolder(accountId, 'Sent', 'sent')
    gesendetId = await createFolder(accountId, 'Gesendet')
    archivId = await createFolder(accountId, 'Archiv', 'archive')

    const other = await pool.query<{ id: string }>(
      `INSERT INTO "user" (email, password_hash) VALUES ('other-f@example.com', 'x') RETURNING id`,
    )
    const foreign = await createAccount(other.rows[0]!.id)
    foreignFolderId = await createFolder(foreign, 'Junk')
  })

  afterAll(async () => {
    await pool.query(`TRUNCATE ${TABLES} CASCADE`)
    await pool.end()
  })

  it('requires authentication and validates the role', async () => {
    expect((await patch(sentId, { specialUse: 'sent' }, null)).statusCode).toBe(401)
    for (const body of [
      {},
      { specialUse: 'inbox' },
      { specialUse: 'flagged' },
      { specialUse: 1 },
    ]) {
      expect((await patch(sentId, body)).statusCode).toBe(400)
    }
    expect((await patch(inboxId, { specialUse: 'sent' })).statusCode).toBe(400)
  })

  it('answers 404 for foreign or unknown folders', async () => {
    expect((await patch(foreignFolderId, { specialUse: 'junk' })).statusCode).toBe(404)
    expect((await patch(randomUUID(), { specialUse: 'junk' })).statusCode).toBe(404)
    expect((await patch('nope', { specialUse: 'junk' })).statusCode).toBe(404)
    const { rows } = await pool.query('SELECT special_use_override FROM folder WHERE id = $1', [
      foreignFolderId,
    ])
    expect(rows[0].special_use_override).toBeNull()
  })

  it('moves a role to the chosen folder, one folder per role', async () => {
    expect((await patch(gesendetId, { specialUse: 'sent' })).statusCode).toBe(204)
    expect(await roles(accountId)).toEqual({
      INBOX: 'inbox',
      Gesendet: 'sent*',
      Archiv: 'archive',
      Sent: 'null',
    })
    // Assigning the role to another folder moves the override.
    expect((await patch(archivId, { specialUse: 'sent' })).statusCode).toBe(204)
    expect(await roles(accountId)).toEqual({
      INBOX: 'inbox',
      Archiv: 'sent*',
      Sent: 'null',
      Gesendet: 'null',
    })
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM folder WHERE account_id = $1 AND special_use = 'sent'`,
      [accountId],
    )
    expect(rows[0].n).toBe(1)
  })

  it('null returns a folder to automatic detection', async () => {
    expect((await patch(archivId, { specialUse: null })).statusCode).toBe(204)
    expect(await roles(accountId)).toEqual({
      INBOX: 'inbox',
      Archiv: 'archive',
      Sent: 'sent',
      Gesendet: 'null',
    })
  })
})
