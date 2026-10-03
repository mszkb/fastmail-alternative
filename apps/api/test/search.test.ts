/**
 * Integration tests for the search (roadmap 5.1, ADR-0006) against
 * GreenMail: IMAP SEARCH by subject, sender, body text and date range,
 * folder scoping, mapping of provider UIDs to local message ids, counting
 * of unsynced matches, rate limit, ownership - and that the query never
 * shows up in the logs. Requires DATABASE_URL + GreenMail; skipped when
 * unset.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ImapFlow } from 'imapflow'
import { runMigrations } from '@fma/db/migrate'
import {
  encryptField,
  generateDataKey,
  loadMasterKey,
  messageFieldAad,
  wrapDataKey,
} from '@fma/crypto'
import type { SearchResponse } from '@fma/shared'
import { buildApp } from '../src/app'
import { pool } from '../src/db'
import { RATE_LIMIT, resetSearchState, toSearchObject } from '../src/mail/search'

process.env.MASTER_KEY ??= randomBytes(32).toString('base64')

const databaseUrl = process.env.DATABASE_URL
const greenmailHost = process.env.GREENMAIL_HOST
const greenmailUser = process.env.GREENMAIL_USER ?? ''
const greenmailPassword = process.env.GREENMAIL_PASSWORD ?? ''

const TABLES =
  'session, device, "user", mail_account, identity, folder, job, message, message_location, message_body'
const FOLDER_A = 'FmaSearchA'
const FOLDER_B = 'FmaSearchB'
// Unique per run: GreenMail keeps mail across test files.
const TOKEN = `zq${randomBytes(4).toString('hex')}`

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

describe('search criteria', () => {
  it('maps the query onto IMAP SEARCH (dates as UTC days)', () => {
    expect(
      toSearchObject({
        q: 'a',
        from: 'b',
        subject: 'c',
        since: '2026-01-01',
        before: '2026-02-01',
      }),
    ).toEqual({
      text: 'a',
      from: 'b',
      subject: 'c',
      since: new Date('2026-01-01T00:00:00Z'),
      before: new Date('2026-02-01T00:00:00Z'),
    })
  })
})

describe.skipIf(!databaseUrl || !greenmailHost)('search api', () => {
  let app: FastifyInstance
  let logOutput = ''
  let authToken: string
  let accountId: string
  let dek: Buffer
  const folderIds: Record<string, string> = {}
  /** Local message id per subject (synced messages only). */
  const local: Record<string, string> = {}

  function search(params: Record<string, string>, account = accountId) {
    return app.inject({
      method: 'GET',
      url: `/api/accounts/${account}/search?${new URLSearchParams(params).toString()}`,
      headers: { cookie: `fma_session=${authToken}` },
    })
  }

  async function seedFolder(
    path: string,
    mails: { subject: string; from: string; body: string; date: string; synced: boolean }[],
  ): Promise<void> {
    const client = imapClient()
    await client.connect()
    await client.mailboxDelete(path).catch(() => {})
    await client.mailboxCreate(path)
    for (const mail of mails) {
      const raw =
        `From: ${mail.from}\r\nTo: ${greenmailUser}\r\nSubject: ${mail.subject}\r\n` +
        `Date: ${new Date(mail.date).toUTCString()}\r\n` +
        `Message-ID: <${randomUUID()}@example.com>\r\n\r\n${mail.body}\r\n`
      await client.append(path, Buffer.from(raw), ['\\Seen'], new Date(mail.date))
    }
    const lock = await client.getMailboxLock(path)
    const uidBySubject = new Map<string, number>()
    let uidValidity = ''
    try {
      uidValidity = String(client.mailbox ? client.mailbox.uidValidity : '')
      for await (const msg of client.fetch('1:*', { uid: true, envelope: true })) {
        uidBySubject.set(msg.envelope?.subject ?? '', msg.uid)
      }
    } finally {
      lock.release()
      await client.logout().catch(() => client.close())
    }
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO folder (account_id, path, delimiter, uidvalidity, special_use)
       VALUES ($1, $2, '.', $3, $4) RETURNING id`,
      [accountId, path, uidValidity, path === FOLDER_A ? 'archive' : null],
    )
    folderIds[path] = rows[0]!.id
    // Synced messages get local rows, like the message sync stores them.
    for (const mail of mails.filter((m) => m.synced)) {
      const id = randomUUID()
      const enc = (field: Parameters<typeof messageFieldAad>[0], value: string) =>
        Buffer.from(encryptField(dek, value, messageFieldAad(field, id)), 'utf8')
      await pool.query(
        `INSERT INTO message (id, account_id, message_id_header, subject_enc, from_enc,
           recipients_enc, snippet_enc, sent_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          id,
          accountId,
          `<${id}@example.com>`,
          enc('subject', mail.subject),
          enc('from', JSON.stringify([{ name: '', address: mail.from }])),
          enc('recipients', '{}'),
          enc('snippet', mail.body),
          mail.date,
        ],
      )
      await pool.query(
        `INSERT INTO message_location (message_id, folder_id, uidvalidity, uid)
         VALUES ($1, $2, $3, $4)`,
        [id, folderIds[path], uidValidity, uidBySubject.get(mail.subject)],
      )
      local[mail.subject] = id
    }
  }

  beforeAll(async () => {
    const stream = new PassThrough()
    stream.on('data', (chunk) => {
      logOutput += String(chunk)
    })
    app = buildApp({ logStream: stream })
    await runMigrations(pool)
    await pool.query(`TRUNCATE ${TABLES} CASCADE`)
    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { email: 'search@example.com', password: 'correct horse battery' },
    })
    authToken = setup.cookies.find((c) => c.name === 'fma_session')!.value
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM "user"')

    accountId = randomUUID()
    dek = generateDataKey()
    await pool.query(
      `INSERT INTO mail_account
         (id, user_id, display_name, email_address, imap_host, imap_port,
          smtp_host, smtp_port, wrapped_dek, key_id, credential_enc, status)
       VALUES ($1, $2, 'Such-Test', $3, $4, $5, $4, $6, $7, 'v1', $8, 'ok')`,
      [
        accountId,
        rows[0]!.id,
        greenmailUser,
        greenmailHost,
        Number(process.env.GREENMAIL_IMAP_PORT),
        Number(process.env.GREENMAIL_SMTP_PORT),
        Buffer.from(wrapDataKey(loadMasterKey(process.env.MASTER_KEY!), dek, 'v1'), 'utf8'),
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

    await seedFolder(FOLDER_A, [
      {
        subject: `Rechnung ${TOKEN} Januar`,
        from: 'billing@shop.example',
        body: 'Ihre Rechnung liegt bei.',
        date: '2026-01-15T10:00:00Z',
        synced: true,
      },
      {
        subject: 'Projekttreffen',
        from: `anna.${TOKEN}@example.org`,
        body: 'Treffen am Montag.',
        date: '2026-02-10T10:00:00Z',
        synced: true,
      },
      {
        subject: 'Noch nicht synchronisiert',
        from: 'old@example.org',
        body: `Geheimwort ${TOKEN}body im Text.`,
        date: '2026-03-01T10:00:00Z',
        synced: false,
      },
    ])
    await seedFolder(FOLDER_B, [
      {
        subject: `Rechnung ${TOKEN} Februar`,
        from: 'billing@shop.example',
        body: 'Zweite Rechnung.',
        date: '2026-02-20T10:00:00Z',
        synced: true,
      },
      {
        subject: 'Urlaub',
        from: 'team@example.org',
        body: `Wir fahren weg, Stichwort ${TOKEN}body.`,
        date: '2026-04-01T10:00:00Z',
        synced: true,
      },
    ])
  })

  beforeEach(() => {
    resetSearchState()
  })

  afterAll(async () => {
    const cleanup = imapClient()
    await cleanup.connect()
    await cleanup.mailboxDelete(FOLDER_A).catch(() => {})
    await cleanup.mailboxDelete(FOLDER_B).catch(() => {})
    await cleanup.logout().catch(() => cleanup.close())
    await pool.query(`TRUNCATE ${TABLES} CASCADE`)
    await app.close()
    await pool.end()
  })

  it('finds by subject across folders and maps the hits to local messages', async () => {
    const res = await search({ subject: `Rechnung ${TOKEN}` })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    const body = res.json<SearchResponse>()
    expect(body.messages.map((m) => [m.id, m.folderId, m.subject])).toEqual([
      [local[`Rechnung ${TOKEN} Februar`], folderIds[FOLDER_B], `Rechnung ${TOKEN} Februar`],
      [local[`Rechnung ${TOKEN} Januar`], folderIds[FOLDER_A], `Rechnung ${TOKEN} Januar`],
    ])
    expect(body).toMatchObject({
      providerMatches: 2,
      notSynced: 0,
      truncated: false,
      foldersSearched: 2,
      foldersFailed: 0,
    })
  })

  it('finds by sender', async () => {
    // GreenMail matches FROM only against the full address (real servers:
    // substring, RFC 3501) - search quality is provider-dependent (ADR-0006).
    const body = (await search({ from: `anna.${TOKEN}@example.org` })).json<SearchResponse>()
    expect(body.messages.map((m) => m.subject)).toEqual(['Projekttreffen'])
  })

  it('finds body text and counts matches that are not synced locally', async () => {
    const body = (await search({ q: `${TOKEN}body` })).json<SearchResponse>()
    expect(body.messages.map((m) => m.subject)).toEqual(['Urlaub'])
    expect(body.providerMatches).toBe(2)
    expect(body.notSynced).toBe(1)
  })

  it('filters by date range (since inclusive, before exclusive)', async () => {
    const body = (
      await search({ q: TOKEN, since: '2026-02-01', before: '2026-03-01' })
    ).json<SearchResponse>()
    expect(body.messages.map((m) => m.subject).sort()).toEqual([
      'Projekttreffen',
      `Rechnung ${TOKEN} Februar`,
    ])
  })

  it('searches only the given folder', async () => {
    const body = (
      await search({ subject: `Rechnung ${TOKEN}`, folderId: folderIds[FOLDER_A]! })
    ).json<SearchResponse>()
    expect(body.messages.map((m) => m.folderId)).toEqual([folderIds[FOLDER_A]])
    expect(body.foldersSearched).toBe(1)
  })

  it('never logs the query', async () => {
    const secret = `geheim${randomBytes(4).toString('hex')}`
    logOutput = ''
    expect((await search({ q: secret, from: secret, subject: secret })).statusCode).toBe(200)
    expect(logOutput).toContain('/search')
    expect(logOutput).not.toContain(secret)
    expect(logOutput).not.toContain('q=')
  })

  it('validates input, checks ownership and rate-limits provider searches', async () => {
    expect((await search({})).statusCode).toBe(400)
    expect((await search({ since: 'gestern' })).statusCode).toBe(400)
    expect((await search({ q: 'x', folderId: randomUUID() })).statusCode).toBe(404)
    expect((await search({ q: 'x' }, randomUUID())).statusCode).toBe(404)

    // Repeats of one search come from the short-lived cache.
    for (let i = 0; i < RATE_LIMIT + 2; i++) {
      expect((await search({ subject: TOKEN, folderId: folderIds[FOLDER_B]! })).statusCode).toBe(
        200,
      )
    }
    for (let i = 1; i < RATE_LIMIT; i++) {
      expect(
        (await search({ subject: `${TOKEN}-${i}`, folderId: folderIds[FOLDER_B]! })).statusCode,
      ).toBe(200)
    }
    const limited = await search({ subject: `${TOKEN}-x`, folderId: folderIds[FOLDER_B]! })
    expect(limited.statusCode).toBe(429)
  })

  it('does not contact the provider for accounts with an auth error', async () => {
    await pool.query(`UPDATE mail_account SET status = 'auth_error' WHERE id = $1`, [accountId])
    try {
      expect((await search({ q: `${TOKEN}-auth` })).statusCode).toBe(409)
    } finally {
      await pool.query(`UPDATE mail_account SET status = 'ok' WHERE id = $1`, [accountId])
    }
  })
})
