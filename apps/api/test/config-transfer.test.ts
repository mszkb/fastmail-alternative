/**
 * Integration tests for the configuration export/import (roadmap 4.7):
 * the export contains no secret (passwords, DEKs, credential blobs), the
 * import recreates accounts, identities and folder mappings that wait for
 * the password (auth_error/CREDENTIALS_REQUIRED, no jobs), and entering the
 * password brings the account back. Requires DATABASE_URL and GreenMail
 * (see accounts.test.ts); skipped when unset.
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { decryptField, unwrapAccountKey } from '@fma/crypto'
import { runMigrations } from '@fma/db/migrate'
import type { AccountListResponse, ConfigExport, IdentityListResponse } from '@fma/shared'
import { buildApp } from '../src/app'
import { pool } from '../src/db'

/** Setup code configured for the tests (vitest.config.ts). */
const SETUP_CODE = 'test-setup-code'

process.env.MASTER_KEY ??= randomBytes(32).toString('base64')

const databaseUrl = process.env.DATABASE_URL
const greenmailHost = process.env.GREENMAIL_HOST
const TABLES = 'session, device, "user", mail_account, identity, folder, job'

let app: FastifyInstance
let authToken: string

function inject(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: { cookie: `fma_session=${authToken}` },
  })
}

describe.skipIf(!databaseUrl || !greenmailHost)('configuration export/import', () => {
  const password = process.env.GREENMAIL_PASSWORD!
  let exported: ConfigExport
  let rawExport: string

  beforeAll(async () => {
    // Many writes from one test IP; rate limits are covered in security.test.ts.
    app = buildApp({ logger: false, rateLimits: [] })
    await runMigrations(pool)
    await pool.query(`TRUNCATE ${TABLES} CASCADE`)
    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: {
        setupCode: SETUP_CODE,
        email: 'export@example.com',
        password: 'correct horse battery',
      },
    })
    authToken = setup.cookies.find((c) => c.name === 'fma_session')!.value

    const created = await inject('POST', '/api/accounts', {
      displayName: 'Privat',
      emailAddress: process.env.GREENMAIL_USER,
      imap: {
        host: greenmailHost,
        port: Number(process.env.GREENMAIL_IMAP_PORT),
        user: process.env.GREENMAIL_USER,
        password,
      },
      smtp: { host: greenmailHost, port: Number(process.env.GREENMAIL_SMTP_PORT) },
    })
    expect(created.statusCode).toBe(201)
    const accountId = created.json().account.id as string
    const alias = await inject('POST', `/api/accounts/${accountId}/identities`, {
      name: 'Info',
      emailAddress: 'info@example.com',
      signature: 'Gruß\nInfo',
    })
    expect(alias.statusCode).toBe(201)
    expect(
      (await inject('PATCH', `/api/identities/${alias.json().identity.id}`, { isDefault: true }))
        .statusCode,
    ).toBe(200)
    await pool.query(
      `INSERT INTO folder (account_id, path, delimiter, special_use, special_use_override)
       VALUES ($1, 'Gesendete Objekte', '/', 'sent', 'sent')`,
      [accountId],
    )
  })

  afterAll(async () => {
    await pool.query(`TRUNCATE ${TABLES} CASCADE`)
    await pool.end()
  })

  it('exports accounts, identities and folder mappings without secrets', async () => {
    const res = await inject('GET', '/api/export/config')
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="fma-config-/)
    rawExport = res.body
    exported = JSON.parse(rawExport) as ConfigExport
    expect(exported).toMatchObject({ format: 'fma-config', version: 1, settings: {} })
    expect(exported.accounts).toHaveLength(1)
    expect(exported.accounts[0]).toMatchObject({
      displayName: 'Privat',
      emailAddress: process.env.GREENMAIL_USER,
      credentialKind: 'password',
      imap: { host: greenmailHost, user: process.env.GREENMAIL_USER },
      smtp: { host: greenmailHost, user: process.env.GREENMAIL_USER },
      folderRoles: { sent: { path: 'Gesendete Objekte', delimiter: '/' } },
    })
    expect(exported.accounts[0]!.identities).toEqual([
      { name: 'Info', emailAddress: 'info@example.com', signature: 'Gruß\nInfo', isDefault: true },
      {
        name: 'Privat',
        emailAddress: process.env.GREENMAIL_USER,
        signature: null,
        isDefault: false,
      },
    ])

    // No secret of any kind in the file.
    const { rows } = await pool.query<{ wrapped_dek: Buffer; credential_enc: Buffer }>(
      'SELECT wrapped_dek, credential_enc FROM mail_account',
    )
    expect(rawExport).not.toContain(password)
    expect(rawExport).not.toContain(rows[0]!.wrapped_dek.toString('utf8'))
    expect(rawExport).not.toContain(rows[0]!.credential_enc.toString('utf8'))
    // No key that could carry one either ("credentialKind": "password" is the login type).
    expect(rawExport).not.toMatch(
      /"[^"]*(password|token|secret|dek|wrapped|credential_)[^"]*"\s*:/i,
    )
    expect(rawExport).not.toContain(process.env.MASTER_KEY!)
  })

  it('imports onto a fresh instance; accounts wait for their password', async () => {
    const accounts = (await inject('GET', '/api/accounts')).json<AccountListResponse>().accounts
    expect((await inject('DELETE', `/api/accounts/${accounts[0]!.id}`)).statusCode).toBe(204)
    await pool.query('DELETE FROM job')

    const res = await inject('POST', '/api/import/config', exported)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ imported: [process.env.GREENMAIL_USER], skipped: [] })

    const [account] = (await inject('GET', '/api/accounts')).json<AccountListResponse>().accounts
    expect(account).toMatchObject({
      displayName: 'Privat',
      status: 'auth_error',
      lastErrorCode: 'CREDENTIALS_REQUIRED',
    })
    // Credential blob: user names only, empty passwords.
    const { rows } = await pool.query<{ wrapped_dek: Buffer; credential_enc: Buffer }>(
      'SELECT wrapped_dek, credential_enc FROM mail_account WHERE id = $1',
      [account!.id],
    )
    const dek = unwrapAccountKey(process.env.MASTER_KEY!, rows[0]!.wrapped_dek)
    expect(
      JSON.parse(
        decryptField(
          dek,
          rows[0]!.credential_enc.toString('utf8'),
          `mail_account.credential:${account!.id}`,
        ),
      ),
    ).toEqual({
      imapUser: process.env.GREENMAIL_USER,
      imapPassword: '',
      smtpUser: process.env.GREENMAIL_USER,
      smtpPassword: '',
    })

    const identities = (
      await inject('GET', `/api/accounts/${account!.id}/identities`)
    ).json<IdentityListResponse>().identities
    expect(identities.map((i) => [i.emailAddress, i.isDefault, i.signature])).toEqual([
      ['info@example.com', true, 'Gruß\nInfo'],
      [process.env.GREENMAIL_USER, false, null],
    ])
    const folders = await pool.query(
      'SELECT path, special_use, special_use_override FROM folder WHERE account_id = $1',
      [account!.id],
    )
    expect(folders.rows).toEqual([
      { path: 'Gesendete Objekte', special_use: 'sent', special_use_override: 'sent' },
    ])

    // No sync before the password is entered, also not on request.
    await inject('POST', '/api/sync')
    expect((await pool.query('SELECT 1 FROM job')).rowCount).toBe(0)

    // Round trip: the re-export equals the original (apart from the timestamp).
    const again = (await inject('GET', '/api/export/config')).json<ConfigExport>()
    expect({ ...again, exportedAt: '' }).toEqual({ ...exported, exportedAt: '' })
  })

  it('skips existing accounts and rejects foreign or newer files', async () => {
    const res = await inject('POST', '/api/import/config', exported)
    expect(res.json()).toEqual({ imported: [], skipped: [process.env.GREENMAIL_USER] })
    for (const body of [
      {},
      { ...exported, format: 'other' },
      { ...exported, version: 99 },
      { ...exported, accounts: [{ emailAddress: 'x' }] },
      {
        ...exported,
        accounts: [{ ...exported.accounts[0], folderRoles: { inbox: { path: 'X' } } }],
      },
    ]) {
      expect((await inject('POST', '/api/import/config', body)).statusCode).toBe(400)
    }
  })

  it('entering the password reactivates the account and starts the sync', async () => {
    const [account] = (await inject('GET', '/api/accounts')).json<AccountListResponse>().accounts
    const res = await inject('PATCH', `/api/accounts/${account!.id}`, { imap: { password } })
    expect(res.statusCode).toBe(200)
    expect(res.json().account).toMatchObject({ status: 'ok', lastErrorCode: null })
    const jobs = await pool.query(`SELECT type FROM job WHERE account_id = $1`, [account!.id])
    expect(jobs.rows).toEqual([{ type: 'folder_sync' }])
  })
})
