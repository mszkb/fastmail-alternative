/**
 * Integration tests for the mail read API (roadmap 2.3): folder tree order,
 * keyset pagination (stable while new mail arrives), decrypted fields
 * without ciphertext leakage, and ownership checks (404 for foreign ids).
 *
 * Seeds folders/messages directly, encrypted with the account DEK exactly
 * like the worker's message sync does. Requires DATABASE_URL; skipped when
 * unset.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { runMigrations } from '@fma/db/migrate'
import {
  encryptField,
  generateDataKey,
  loadMasterKey,
  messageFieldAad,
  wrapDataKey,
} from '@fma/crypto'
import type { FolderSummary, MessageListItem, ThreadDetail } from '@fma/shared'
import { buildApp } from '../src/app'
import { pool } from '../src/db'

/** Setup code configured for the tests (vitest.config.ts). */
const SETUP_CODE = 'test-setup-code'

process.env.MASTER_KEY ??= randomBytes(32).toString('base64')

const databaseUrl = process.env.DATABASE_URL
const TABLES =
  'session, device, "user", mail_account, identity, folder, job, message, message_location, message_body'

let app: FastifyInstance
let authToken: string

async function get(url: string, token?: string) {
  return app.inject({
    method: 'GET',
    url,
    headers: token ? { cookie: `fma_session=${token}` } : {},
  })
}

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
  delimiter = '/',
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO folder (account_id, path, delimiter, special_use, uidvalidity)
     VALUES ($1, $2, $3, $4, 1) RETURNING id`,
    [accountId, path, delimiter, specialUse],
  )
  return rows[0]!.id
}

let uidCounter = 1

async function createMessage(
  account: { id: string; dek: Buffer },
  folderId: string,
  opts: {
    subject: string
    sentAt: string | null
    flags?: string[]
    text?: string
    from?: { name: string; address: string }
    replyTo?: { name: string; address: string }[]
    messageIdHeader?: string
    references?: string[]
  },
): Promise<string> {
  const id = randomUUID()
  const enc = (field: Parameters<typeof messageFieldAad>[0], value: string) =>
    Buffer.from(encryptField(account.dek, value, messageFieldAad(field, id)), 'utf8')
  await pool.query(
    `INSERT INTO message
       (id, account_id, message_id_header, subject_enc, from_enc, recipients_enc,
        snippet_enc, sent_at, received_at, has_attachments, "references")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '2020-01-01T00:00:00Z', false, $9)`,
    [
      id,
      account.id,
      opts.messageIdHeader ?? `<${id}@test>`,
      enc('subject', opts.subject),
      enc('from', JSON.stringify([opts.from ?? { name: 'Alice', address: 'alice@example.com' }])),
      enc(
        'recipients',
        JSON.stringify({
          to: [{ name: 'Bob', address: 'bob@example.com' }],
          cc: [{ name: '', address: 'carol@example.com' }],
          ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
        }),
      ),
      enc('snippet', `Snippet of ${opts.subject}`),
      opts.sentAt,
      opts.references ?? [],
    ],
  )
  await pool.query(
    `INSERT INTO message_location (message_id, folder_id, uidvalidity, uid, flags)
     VALUES ($1, $2, 1, $3, $4)`,
    [id, folderId, uidCounter++, opts.flags ?? []],
  )
  if (opts.text !== undefined) {
    await pool.query(
      `INSERT INTO message_body (message_id, storage_ref, text_plain_enc)
       VALUES ($1, $2, $3)`,
      [id, `${account.id}/${id}/raw.eml.enc`, enc('text', opts.text)],
    )
  }
  return id
}

describe.skipIf(!databaseUrl)('mail read api', () => {
  let account: { id: string; dek: Buffer }
  let inboxId: string
  let foreignAccountId: string
  let foreignFolderId: string
  let foreignMessageId: string
  let detailMessageId: string

  beforeAll(async () => {
    app = buildApp({ logger: false })
    await runMigrations(pool)
    await pool.query(`TRUNCATE ${TABLES} CASCADE`)

    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: {
        setupCode: SETUP_CODE,
        email: 'reader@example.com',
        password: 'correct horse battery',
      },
    })
    authToken = setup.cookies.find((c) => c.name === 'fma_session')!.value
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM "user"')
    account = await createAccount(rows[0]!.id)

    // Folders in deliberately "wrong" insert order.
    await createFolder(account.id, 'Zeta')
    await createFolder(account.id, 'Projects/Alpha')
    await createFolder(account.id, 'Trash', 'trash')
    await createFolder(account.id, 'Projects')
    await createFolder(account.id, 'Sent', 'sent')
    await createFolder(account.id, 'INBOX/Receipts')
    await createFolder(account.id, 'archive-old')
    await createFolder(account.id, 'Drafts', 'drafts')
    inboxId = await createFolder(account.id, 'INBOX')

    // A second user's account (direct insert; the instance is single-user,
    // but ownership checks must hold regardless).
    const other = await pool.query<{ id: string }>(
      `INSERT INTO "user" (email, password_hash) VALUES ('other@example.com', 'x') RETURNING id`,
    )
    const foreign = await createAccount(other.rows[0]!.id)
    foreignAccountId = foreign.id
    foreignFolderId = await createFolder(foreign.id, 'INBOX')
    foreignMessageId = await createMessage(foreign, foreignFolderId, {
      subject: 'Foreign secret',
      sentAt: '2026-01-01T00:00:00Z',
      text: 'not yours',
    })
  })

  afterAll(async () => {
    await pool.query(`TRUNCATE ${TABLES} CASCADE`)
    await pool.end()
  })

  it('requires authentication', async () => {
    expect((await get(`/api/accounts/${account.id}/folders`)).statusCode).toBe(401)
    expect((await get(`/api/folders/${inboxId}/messages`)).statusCode).toBe(401)
    expect((await get(`/api/messages/${randomUUID()}`)).statusCode).toBe(401)
  })

  it('returns 404 for foreign, unknown and malformed ids', async () => {
    for (const url of [
      `/api/accounts/${foreignAccountId}/folders`,
      `/api/accounts/${randomUUID()}/folders`,
      '/api/accounts/not-a-uuid/folders',
      `/api/folders/${foreignFolderId}/messages`,
      `/api/folders/${randomUUID()}/messages`,
      `/api/messages/${foreignMessageId}`,
      `/api/messages/${randomUUID()}`,
      '/api/messages/1',
    ]) {
      const res = await get(url, authToken)
      expect(res.statusCode, url).toBe(404)
      expect(res.body).not.toContain('Foreign secret')
    }
  })

  it('lists folders as a tree: INBOX first, then special-use, then by name', async () => {
    const res = await get(`/api/accounts/${account.id}/folders`, authToken)
    expect(res.statusCode).toBe(200)
    const folders = res.json().folders as FolderSummary[]
    expect(folders.map((f) => `${'  '.repeat(f.depth)}${f.name}`)).toEqual([
      'INBOX',
      '  Receipts',
      'Drafts',
      'Sent',
      'Trash',
      'archive-old',
      'Projects',
      '  Alpha',
      'Zeta',
    ])
    const alpha = folders.find((f) => f.path === 'Projects/Alpha')!
    const projects = folders.find((f) => f.path === 'Projects')!
    expect(alpha.parentId).toBe(projects.id)
    expect(projects.parentId).toBeNull()
    expect(folders[0]!.specialUse).toBe('inbox')
    expect(folders.every((f) => f.selectable)).toBe(true)
  })

  it('marks \\Noselect containers as not selectable but keeps them in the tree', async () => {
    await pool.query(
      `UPDATE folder SET selectable = false WHERE account_id = $1 AND path = 'Projects'`,
      [account.id],
    )
    try {
      const res = await get(`/api/accounts/${account.id}/folders`, authToken)
      const folders = res.json().folders as FolderSummary[]
      const projects = folders.find((f) => f.path === 'Projects')!
      expect(projects.selectable).toBe(false)
      expect(folders.find((f) => f.path === 'Projects/Alpha')!.parentId).toBe(projects.id)
    } finally {
      await pool.query(`UPDATE folder SET selectable = true WHERE account_id = $1`, [account.id])
    }
  })

  it('pages newest first with a stable keyset cursor', async () => {
    // 7 messages: two share a timestamp, two differ only by microseconds,
    // one has no Date header (falls back to received_at, i.e. oldest).
    const seeds: [string, string | null, string[]][] = [
      ['m1', '2026-03-01T10:00:00Z', ['\\Seen']],
      ['m2', '2026-03-02T10:00:00Z', []],
      ['m3', '2026-03-03T10:00:00Z', ['\\Seen', '\\Flagged']],
      ['m4', '2026-03-03T10:00:00Z', []],
      ['m5', '2026-03-04 10:00:00.000001+00', ['\\Answered', '\\Seen']],
      ['m6', '2026-03-04 10:00:00.000002+00', []],
      ['m0', null, ['\\Seen']],
    ]
    for (const [subject, sentAt, flags] of seeds) {
      await createMessage(account, inboxId, { subject, sentAt, flags })
    }

    const page1 = await get(`/api/folders/${inboxId}/messages?limit=3`, authToken)
    expect(page1.statusCode).toBe(200)
    const body1 = page1.json() as { messages: MessageListItem[]; nextCursor: string | null }
    expect(body1.messages.map((m) => m.subject).slice(0, 2)).toEqual(['m6', 'm5'])
    expect(body1.nextCursor).toBeTruthy()

    // New mail arriving between page loads must not shift the next page.
    await createMessage(account, inboxId, { subject: 'new', sentAt: '2026-04-01T00:00:00Z' })

    const seen: string[] = [...body1.messages.map((m) => m.subject)]
    let cursor = body1.nextCursor
    while (cursor) {
      const res = await get(
        `/api/folders/${inboxId}/messages?limit=3&cursor=${encodeURIComponent(cursor)}`,
        authToken,
      )
      expect(res.statusCode).toBe(200)
      const body = res.json() as { messages: MessageListItem[]; nextCursor: string | null }
      seen.push(...body.messages.map((m) => m.subject))
      cursor = body.nextCursor
    }
    expect(seen).toHaveLength(7)
    expect(new Set(seen).size).toBe(7)
    expect(seen.slice(0, 2)).toEqual(['m6', 'm5'])
    expect(new Set(seen.slice(2, 4))).toEqual(new Set(['m3', 'm4']))
    expect(seen.slice(4)).toEqual(['m2', 'm1', 'm0'])

    const fresh = await get(`/api/folders/${inboxId}/messages`, authToken)
    const all = fresh.json() as { messages: MessageListItem[]; nextCursor: string | null }
    expect(all.messages).toHaveLength(8) // default limit 50
    expect(all.nextCursor).toBeNull()
    expect(all.messages[0]!.subject).toBe('new')
  })

  it('returns decrypted list fields and flags without ciphertext', async () => {
    const res = await get(`/api/folders/${inboxId}/messages`, authToken)
    expect(res.body).not.toContain('fma.f1.')
    const m5 = (res.json().messages as MessageListItem[]).find((m) => m.subject === 'm5')!
    expect(m5).toMatchObject({
      from: { name: 'Alice', address: 'alice@example.com' },
      snippet: 'Snippet of m5',
      flags: { seen: true, flagged: false, answered: true },
      hasAttachments: false,
    })
    expect(m5.date).toBe('2026-03-04T10:00:00.000Z')
  })

  it('reports unread and total counts per folder', async () => {
    const res = await get(`/api/accounts/${account.id}/folders`, authToken)
    const inbox = (res.json().folders as FolderSummary[]).find((f) => f.id === inboxId)!
    expect(inbox.total).toBe(8)
    expect(inbox.unreadCount).toBe(4) // m2, m4, m6, new
  })

  it('rejects invalid cursors and limits, caps the limit', async () => {
    for (const query of ['cursor=garbage', 'limit=0', 'limit=abc', 'cursor=' + 'x'.repeat(10)]) {
      const res = await get(`/api/folders/${inboxId}/messages?${query}`, authToken)
      expect(res.statusCode, query).toBe(400)
    }
    const capped = await get(`/api/folders/${inboxId}/messages?limit=1000`, authToken)
    expect(capped.statusCode).toBe(200)
  })

  it('returns message details with decrypted plain text, without marking as read', async () => {
    detailMessageId = await createMessage(account, inboxId, {
      subject: 'Grüße aus Köln',
      sentAt: '2026-02-01T08:30:00Z',
      text: 'Hallo Bob,\n<script>alert(1)</script>\nBis bald',
      from: { name: 'Zoë', address: 'zoe@example.com' },
    })
    const res = await get(`/api/messages/${detailMessageId}`, authToken)
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain('fma.f1.')
    expect(res.json()).toEqual({
      id: detailMessageId,
      accountId: account.id,
      folderIds: [inboxId],
      subject: 'Grüße aus Köln',
      from: { name: 'Zoë', address: 'zoe@example.com' },
      to: [{ name: 'Bob', address: 'bob@example.com' }],
      cc: [{ name: '', address: 'carol@example.com' }],
      replyTo: [],
      deliveredTo: [],
      date: '2026-02-01T08:30:00.000Z',
      flags: { seen: false, flagged: false, answered: false },
      hasAttachments: false,
      messageId: `<${detailMessageId}@test>`,
      references: [],
      text: 'Hallo Bob,\n<script>alert(1)</script>\nBis bald',
      threadId: null,
    })

    const { rows } = await pool.query<{ flags: string[] }>(
      'SELECT flags FROM message_location WHERE message_id = $1',
      [detailMessageId],
    )
    expect(rows[0]!.flags).toEqual([])
  })

  it('returns text null while the body is not downloaded yet', async () => {
    const id = await createMessage(account, inboxId, { subject: 'pending', sentAt: null })
    const res = await get(`/api/messages/${id}`, authToken)
    expect(res.statusCode).toBe(200)
    expect(res.json().text).toBeNull()
  })

  it('exposes Reply-To, Message-ID and References for replies', async () => {
    const id = await createMessage(account, inboxId, {
      subject: 'thread',
      sentAt: '2026-02-02T08:30:00Z',
      replyTo: [{ name: 'List', address: 'list@example.com' }],
      messageIdHeader: '<reply-me@example.com>',
      references: ['<root@example.com>', '<parent@example.com>'],
    })
    const body = (await get(`/api/messages/${id}`, authToken)).json()
    expect(body.replyTo).toEqual([{ name: 'List', address: 'list@example.com' }])
    expect(body.messageId).toBe('<reply-me@example.com>')
    expect(body.references).toEqual(['<root@example.com>', '<parent@example.com>'])
  })

  it('hides synthetic Message-IDs of messages without one', async () => {
    const id = await createMessage(account, inboxId, {
      subject: 'no id',
      sentAt: null,
      messageIdHeader: `<${'ab'.repeat(32)}@fma.local>`,
    })
    const body = (await get(`/api/messages/${id}`, authToken)).json()
    expect(body.messageId).toBeNull()
  })

  describe('threads', () => {
    let threadId: string
    let inboxReplyId: string
    let sentReplyId: string
    let rootId: string
    let foreignThreadId: string

    async function createThread(accountId: string, messageIds: string[]): Promise<string> {
      const id = randomUUID()
      await pool.query('INSERT INTO thread (id, account_id) VALUES ($1, $2)', [id, accountId])
      await pool.query('UPDATE message SET thread_id = $1 WHERE id = ANY($2::uuid[])', [
        id,
        messageIds,
      ])
      return id
    }

    beforeAll(async () => {
      const sentId = (
        await pool.query<{ id: string }>(
          "SELECT id FROM folder WHERE account_id = $1 AND path = 'Sent'",
          [account.id],
        )
      ).rows[0]!.id
      rootId = await createMessage(account, inboxId, {
        subject: 'Konversation',
        sentAt: '2026-05-01T08:00:00Z',
        text: 'Start',
      })
      sentReplyId = await createMessage(account, sentId, {
        subject: 'Re: Konversation',
        sentAt: '2026-05-02T08:00:00Z',
        text: 'Meine Antwort',
        from: { name: 'Ich', address: 'me@example.com' },
      })
      inboxReplyId = await createMessage(account, inboxId, {
        subject: 'Re: Re: Konversation',
        sentAt: '2026-05-03T08:00:00Z',
        text: 'Ihre Antwort',
      })
      threadId = await createThread(account.id, [rootId, sentReplyId, inboxReplyId])
      foreignThreadId = await createThread(foreignAccountId, [foreignMessageId])
    })

    it('adds thread id and count to list items and details', async () => {
      const res = await get(`/api/folders/${inboxId}/messages`, authToken)
      const items = res.json().messages as MessageListItem[]
      const reply = items.find((m) => m.id === inboxReplyId)!
      expect(reply.threadId).toBe(threadId)
      expect(reply.threadCount).toBe(3) // incl. the reply in Sent
      const single = items.find((m) => m.subject === 'm1')!
      expect(single).toMatchObject({ threadId: null, threadCount: 1 })

      const detail = (await get(`/api/messages/${inboxReplyId}`, authToken)).json()
      expect(detail.threadId).toBe(threadId)
    })

    it('returns all messages of a thread across folders, oldest first', async () => {
      const res = await get(`/api/threads/${threadId}`, authToken)
      expect(res.statusCode).toBe(200)
      expect(res.body).not.toContain('fma.f1.')
      const body = res.json() as ThreadDetail
      expect(body.id).toBe(threadId)
      expect(body.accountId).toBe(account.id)
      expect(body.subject).toBe('Re: Re: Konversation')
      expect(body.messages.map((m) => m.id)).toEqual([rootId, sentReplyId, inboxReplyId])
      expect(body.messages[1]).toMatchObject({
        from: { name: 'Ich', address: 'me@example.com' },
        text: 'Meine Antwort',
        threadId,
      })
      expect(body.messages[1]!.folderIds).not.toContain(inboxId)
    })

    it('answers 401/404 for anonymous, foreign, unknown and malformed thread ids', async () => {
      expect((await get(`/api/threads/${threadId}`)).statusCode).toBe(401)
      for (const id of [foreignThreadId, randomUUID(), 'nope']) {
        const res = await get(`/api/threads/${id}`, authToken)
        expect(res.statusCode, id).toBe(404)
        expect(res.body).not.toContain('Foreign secret')
      }
    })
  })

  describe('identities', () => {
    let identityId: string

    beforeAll(async () => {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO identity (account_id, name, email_address, signature)
         VALUES ($1, 'Test', $2, NULL), ($1, 'Alias', 'alias@example.com', 'Gruß')
         RETURNING id`,
        [account.id, `${account.id}@example.com`],
      )
      identityId = rows[0]!.id
      await pool.query(
        `INSERT INTO identity (account_id, name, email_address) VALUES ($1, 'X', 'x@example.com')`,
        [foreignAccountId],
      )
    })

    it('lists the identities of an account, default first', async () => {
      const res = await get(`/api/accounts/${account.id}/identities`, authToken)
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({
        identities: [
          {
            id: identityId,
            name: 'Test',
            emailAddress: `${account.id}@example.com`,
            signature: null,
            isDefault: true,
          },
          {
            id: expect.any(String),
            name: 'Alias',
            emailAddress: 'alias@example.com',
            signature: 'Gruß',
            isDefault: false,
          },
        ],
      })
    })

    it('updates the signature (normalized), and clears it', async () => {
      const patch = (id: string, payload: unknown, token = authToken) =>
        app.inject({
          method: 'PATCH',
          url: `/api/identities/${id}`,
          headers: { cookie: `fma_session=${token}` },
          payload: payload as Record<string, unknown>,
        })
      const res = await patch(identityId, { signature: 'Martin\r\nTel. 123\n\n' })
      expect(res.statusCode).toBe(200)
      expect(res.json().identity.signature).toBe('Martin\nTel. 123')

      const cleared = await patch(identityId, { signature: '   ' })
      expect(cleared.json().identity.signature).toBeNull()

      expect((await patch(identityId, { signature: 42 })).statusCode).toBe(400)
      expect((await patch(identityId, {})).statusCode).toBe(400)
      expect((await patch(identityId, { signature: 'x'.repeat(10_001) })).statusCode).toBe(400)
      expect((await patch('nope', { signature: 'x' })).statusCode).toBe(404)
      expect((await patch(randomUUID(), { signature: 'x' })).statusCode).toBe(404)
    })

    it('answers 404 for foreign accounts and identities', async () => {
      expect(
        (await get(`/api/accounts/${foreignAccountId}/identities`, authToken)).statusCode,
      ).toBe(404)
      expect((await get(`/api/accounts/nope/identities`, authToken)).statusCode).toBe(404)
      expect((await get(`/api/accounts/${account.id}/identities`)).statusCode).toBe(401)
      const { rows } = await pool.query<{ id: string }>(
        'SELECT id FROM identity WHERE account_id = $1',
        [foreignAccountId],
      )
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/identities/${rows[0]!.id}`,
        headers: { cookie: `fma_session=${authToken}` },
        payload: { signature: 'hijack' },
      })
      expect(res.statusCode).toBe(404)
      const after = await pool.query('SELECT signature FROM identity WHERE id = $1', [rows[0]!.id])
      expect(after.rows[0].signature).toBeNull()
    })
  })
})
