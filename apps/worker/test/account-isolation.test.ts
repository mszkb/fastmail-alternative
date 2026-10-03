/**
 * Error isolation per account (roadmap 3.4): a broken account (closed port,
 * wrong password, provider that never answers) must not block a healthy
 * one; broken accounts get a status, an error code and a backoff (circuit
 * breaker). Requires DATABASE_URL and GreenMail; skipped when unset.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { runMigrations } from '@fma/db/migrate'
import { claimNextJob, enqueueJob } from '@fma/db/job-queue'
import { encryptField, generateDataKey, loadMasterKey, wrapDataKey } from '@fma/crypto'
import {
  CIRCUIT_OPEN_AFTER,
  JobTimeoutError,
  classifyAccountError,
  recordAccountFailure,
} from '../src/account-health'
import { JobRunner } from '../src/runner'
import { enqueueDueSyncs } from '../src/scheduler'

process.env.MASTER_KEY ??= randomBytes(32).toString('base64')

const databaseUrl = process.env.DATABASE_URL
const greenmailHost = process.env.GREENMAIL_HOST

describe('classifyAccountError', () => {
  it('maps provider errors to codes and kinds', () => {
    expect(classifyAccountError({ authenticationFailed: true })).toEqual({
      code: 'AUTH_FAILED',
      kind: 'auth',
    })
    expect(classifyAccountError({ code: 'EAUTH' })?.kind).toBe('auth')
    expect(classifyAccountError({ code: 'ECONNREFUSED' })).toEqual({
      code: 'CONNECTION_REFUSED',
      kind: 'unreachable',
    })
    expect(classifyAccountError({ code: 'ENOTFOUND' })?.code).toBe('HOST_NOT_FOUND')
    expect(classifyAccountError({ code: 'GREETING_TIMEOUT' })?.code).toBe('TIMEOUT')
    expect(classifyAccountError({ code: 'NoConnection' })?.code).toBe('CONNECTION_LOST')
    expect(classifyAccountError({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' })?.code).toBe('TLS_ERROR')
    expect(classifyAccountError(new JobTimeoutError('folder_sync', 10))?.code).toBe('JOB_TIMEOUT')
    // Codes reported by jobs (send_message).
    expect(classifyAccountError({ code: 'AUTH_FAILED' })?.kind).toBe('auth')
  })

  it('ignores errors that are not about reaching the provider', () => {
    expect(classifyAccountError(new Error('folder x not found for account y'))).toBeNull()
    expect(classifyAccountError({ code: 'SMTP_TEMPORARY' })).toBeNull()
    expect(classifyAccountError({ code: '23505' })).toBeNull() // database
    expect(classifyAccountError(undefined)).toBeNull()
  })
})

describe.skipIf(!databaseUrl || !greenmailHost)('account error isolation', () => {
  let pool: pg.Pool
  let userId: string
  let dataDir: string
  let silentServer: net.Server
  const silentSockets: net.Socket[] = []
  const ids = { healthy: '', refused: '', wrongPassword: '', hanging: '' }

  async function freePort(): Promise<number> {
    const server = net.createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as net.AddressInfo
    await new Promise<void>((resolve) => server.close(() => resolve()))
    return port
  }

  async function createAccount(name: string, host: string, port: number, password: string) {
    const id = randomUUID()
    const dek = generateDataKey()
    const wrappedDek = wrapDataKey(loadMasterKey(process.env.MASTER_KEY!), dek, 'v1')
    const credentialEnc = Buffer.from(
      encryptField(
        dek,
        JSON.stringify({ imapUser: process.env.GREENMAIL_USER, imapPassword: password }),
        `mail_account.credential:${id}`,
      ),
      'utf8',
    )
    await pool.query(
      `INSERT INTO mail_account
         (id, user_id, display_name, email_address, imap_host, imap_port,
          smtp_host, smtp_port, wrapped_dek, key_id, credential_enc, status)
       VALUES ($1, $2, $3, $4, $5, $6, $5, 3025, $7, 'v1', $8, 'ok')`,
      [id, userId, name, process.env.GREENMAIL_USER, host, port, wrappedDek, credentialEnc],
    )
    return id
  }

  async function account(id: string) {
    const { rows } = await pool.query<{
      status: string
      error_count: number
      last_error_code: string | null
      next_retry_at: Date | null
      last_sync_at: Date | null
    }>(
      `SELECT status, error_count, last_error_code, next_retry_at, last_sync_at
       FROM mail_account WHERE id = $1`,
      [id],
    )
    return rows[0]!
  }

  async function jobStates(id: string, type = 'folder_sync'): Promise<string[]> {
    const { rows } = await pool.query<{ state: string }>(
      'SELECT state FROM job WHERE account_id = $1 AND type = $2 ORDER BY id',
      [id, type],
    )
    return rows.map((row) => row.state)
  }

  /** Lets the backoff of an account (and its queued jobs) expire. */
  async function expireBackoff(id: string): Promise<void> {
    await pool.query(
      `UPDATE mail_account SET next_retry_at = now() - interval '1 second' WHERE id = $1`,
      [id],
    )
    await pool.query(`UPDATE job SET run_at = now() WHERE account_id = $1 AND state = 'queued'`, [
      id,
    ])
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl })
    await runMigrations(pool)
    await pool.query(
      'TRUNCATE session, device, "user", mail_account, identity, folder, job, message CASCADE',
    )
    dataDir = await mkdtemp(path.join(tmpdir(), 'fma-isolation-'))
    process.env.MAIL_DATA_DIR = dataDir

    // A "provider" that accepts connections but never says anything.
    silentServer = net.createServer((socket) => {
      silentSockets.push(socket)
    })
    await new Promise<void>((resolve) => silentServer.listen(0, '127.0.0.1', resolve))
    const silentPort = (silentServer.address() as net.AddressInfo).port

    const user = await pool.query<{ id: string }>(
      `INSERT INTO "user" (email, password_hash) VALUES ($1, 'x') RETURNING id`,
      [`isolation-${Date.now()}@example.com`],
    )
    userId = user.rows[0]!.id
    const imapPort = Number(process.env.GREENMAIL_IMAP_PORT)
    const password = process.env.GREENMAIL_PASSWORD!
    // Order matters: the hanging account's job is claimed first.
    ids.hanging = await createAccount('Hanging', '127.0.0.1', silentPort, password)
    ids.refused = await createAccount('Refused', '127.0.0.1', await freePort(), password)
    ids.wrongPassword = await createAccount('Wrong', greenmailHost!, imapPort, 'wrong password 1')
    ids.healthy = await createAccount('Healthy', greenmailHost!, imapPort, password)
  })

  afterAll(async () => {
    for (const socket of silentSockets) socket.destroy()
    await new Promise<void>((resolve) => silentServer.close(() => resolve()))
    await pool.query(
      'TRUNCATE session, device, "user", mail_account, identity, folder, job, message CASCADE',
    )
    await pool.end()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('syncs the healthy account while a broken provider hangs', async () => {
    for (const id of [ids.hanging, ids.refused, ids.wrongPassword, ids.healthy]) {
      await enqueueJob(pool, { type: 'folder_sync', accountId: id })
    }
    const runner = new JobRunner(pool, { concurrency: 2, timeoutMs: () => 8_000 })

    // Run until the healthy account has synced its folders.
    const deadline = Date.now() + 7_000
    await runner.fill()
    while (Date.now() < deadline && !(await jobStates(ids.healthy)).includes('done')) {
      await runner.waitForSlot(100)
      await runner.fill()
    }
    expect(await jobStates(ids.healthy)).toEqual(['done'])
    // ... while the hanging provider still occupies its (single) slot.
    expect(await jobStates(ids.hanging)).toEqual(['running'])

    await runner.drain()

    const healthy = await account(ids.healthy)
    expect(healthy).toMatchObject({ status: 'ok', error_count: 0, last_error_code: null })
    expect(healthy.last_sync_at).not.toBeNull()
    expect(await jobStates(ids.healthy, 'message_sync')).not.toHaveLength(0)
    expect(new Set(await jobStates(ids.healthy, 'message_sync'))).toEqual(new Set(['done']))

    // Hard timeout: aborted, retried later with backoff.
    const hanging = await account(ids.hanging)
    expect(hanging).toMatchObject({ status: 'ok', error_count: 1, last_error_code: 'JOB_TIMEOUT' })
    expect(hanging.next_retry_at!.getTime()).toBeGreaterThan(Date.now())
    expect(await jobStates(ids.hanging)).toEqual(['queued'])

    const refused = await account(ids.refused)
    expect(refused).toMatchObject({
      status: 'ok',
      error_count: 1,
      last_error_code: 'CONNECTION_REFUSED',
    })
    expect(refused.next_retry_at!.getTime()).toBeGreaterThan(Date.now() + 50_000)
    expect(refused.last_sync_at).toBeNull()

    // Wrong password: auth_error, no automatic retry.
    const wrong = await account(ids.wrongPassword)
    expect(wrong).toMatchObject({
      status: 'auth_error',
      last_error_code: 'AUTH_FAILED',
      next_retry_at: null,
    })
  })

  it('does not retry broken accounts before their backoff (and never on auth errors)', async () => {
    await pool.query(`UPDATE job SET run_at = now() WHERE state = 'queued'`)
    expect(await claimNextJob(pool, ['folder_sync'])).toBeNull()

    await pool.query(`UPDATE job SET state = 'done' WHERE state = 'queued'`)
    await pool.query(`UPDATE job SET created_at = now() - interval '1 day'`)
    await expireBackoff(ids.refused)
    const due = await enqueueDueSyncs(pool, 120)
    // Healthy and refused (backoff expired) are due; hanging is in backoff,
    // the auth error waits for new credentials.
    expect(due.sort()).toEqual([ids.healthy, ids.refused].sort())
  })

  it(`opens the circuit after ${CIRCUIT_OPEN_AFTER} consecutive failures`, async () => {
    const runner = new JobRunner(pool, { concurrency: 2, timeoutMs: () => 8_000 })
    let state = await account(ids.refused)
    let previousDelay = 0
    while (state.error_count < CIRCUIT_OPEN_AFTER) {
      await expireBackoff(ids.refused)
      if (!(await jobStates(ids.refused)).includes('queued')) {
        await enqueueJob(pool, { type: 'folder_sync', accountId: ids.refused })
      }
      await runner.drain()
      state = await account(ids.refused)
      // Exponential backoff.
      const delay = state.next_retry_at!.getTime() - Date.now()
      expect(delay).toBeGreaterThan(previousDelay)
      previousDelay = delay
    }
    expect(state).toMatchObject({
      status: 'unreachable',
      error_count: CIRCUIT_OPEN_AFTER,
      last_error_code: 'CONNECTION_REFUSED',
    })
    // 1 min doubling: the third failure waits ~4 min.
    expect(previousDelay).toBeGreaterThan(3.5 * 60_000)

    // Failures inside the open window do not count twice.
    await recordAccountFailure(pool, ids.refused, { code: 'TIMEOUT', kind: 'unreachable' })
    expect((await account(ids.refused)).error_count).toBe(CIRCUIT_OPEN_AFTER)
  })

  it('closes the circuit after a successful sync', async () => {
    // The provider is back (here: the account now points to GreenMail).
    await pool.query('UPDATE mail_account SET imap_host = $2, imap_port = $3 WHERE id = $1', [
      ids.refused,
      greenmailHost,
      Number(process.env.GREENMAIL_IMAP_PORT),
    ])
    await expireBackoff(ids.refused)
    if (!(await jobStates(ids.refused)).includes('queued')) {
      await enqueueJob(pool, { type: 'folder_sync', accountId: ids.refused })
    }
    await new JobRunner(pool, { concurrency: 2 }).drain()
    const state = await account(ids.refused)
    expect(state).toMatchObject({
      status: 'ok',
      error_count: 0,
      last_error_code: null,
      next_retry_at: null,
    })
    expect(state.last_sync_at).not.toBeNull()
    // The auth error stays until the credentials are updated.
    expect((await account(ids.wrongPassword)).status).toBe('auth_error')
  })
})
