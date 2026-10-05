/**
 * Quotas & limits (roadmap 3.5): IMAP connections per provider host, sync
 * debounce and provider throttling. The runner tests need DATABASE_URL and
 * GreenMail; skipped when unset.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { runMigrations } from '@fma/db/migrate'
import { enqueueJob } from '@fma/db/job-queue'
import { encryptField, generateDataKey, loadMasterKey, wrapDataKey } from '@fma/crypto'
import { classifyAccountError, isThrottleError } from '../src/account-health'
import { JobRunner, imapMaxConnectionsPerHost } from '../src/runner'
import { enqueueMessageSync, syncMinIntervalSeconds } from '../src/scheduler'

process.env.MASTER_KEY ??= randomBytes(32).toString('base64')

const databaseUrl = process.env.DATABASE_URL
const greenmailHost = process.env.GREENMAIL_HOST

// The slow provider needs a second loopback address. Linux routes all of
// 127.0.0.0/8 to lo; macOS only 127.0.0.1 unless an alias is added
// (`sudo ifconfig lo0 alias 127.0.0.2 up`).
const secondLoopback = await new Promise<boolean>((resolve) => {
  const probe = net.createServer()
  probe.once('error', () => resolve(false))
  probe.listen(0, '127.0.0.2', () => probe.close(() => resolve(true)))
})

describe('limit configuration', () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
  })

  it('parses IMAP_MAX_CONNECTIONS_PER_HOST with default and invalid values', () => {
    delete process.env.IMAP_MAX_CONNECTIONS_PER_HOST
    expect(imapMaxConnectionsPerHost()).toBe(4)
    process.env.IMAP_MAX_CONNECTIONS_PER_HOST = '10'
    expect(imapMaxConnectionsPerHost()).toBe(10)
    for (const invalid of ['0', '-1', '2.5', 'many', '']) {
      process.env.IMAP_MAX_CONNECTIONS_PER_HOST = invalid
      expect(imapMaxConnectionsPerHost()).toBe(4)
    }
  })

  it('parses SYNC_MIN_INTERVAL_SECONDS with default, 0 and invalid values', () => {
    delete process.env.SYNC_MIN_INTERVAL_SECONDS
    expect(syncMinIntervalSeconds()).toBe(10)
    process.env.SYNC_MIN_INTERVAL_SECONDS = '0'
    expect(syncMinIntervalSeconds()).toBe(0)
    process.env.SYNC_MIN_INTERVAL_SECONDS = '30'
    expect(syncMinIntervalSeconds()).toBe(30)
    for (const invalid of ['-5', 'soon', ' ']) {
      process.env.SYNC_MIN_INTERVAL_SECONDS = invalid
      expect(syncMinIntervalSeconds()).toBe(10)
    }
  })
})

describe('provider throttling', () => {
  it('detects throttling by response code and text', () => {
    expect(isThrottleError({ serverResponseCode: 'LIMIT' })).toBe(true)
    expect(isThrottleError({ serverResponseCode: 'THROTTLED' })).toBe(true)
    expect(
      isThrottleError({ responseText: '[ALERT] Too many simultaneous connections. (Failure)' }),
    ).toBe(true)
    expect(isThrottleError({ serverResponseCode: 'NONEXISTENT' })).toBe(false)
    expect(isThrottleError(new Error('folder not found'))).toBe(false)
    expect(isThrottleError(undefined)).toBe(false)
  })

  it('classifies throttling as RATE_LIMITED (backoff), even when the login was rejected', () => {
    expect(classifyAccountError({ serverResponseCode: 'LIMIT' })).toEqual({
      code: 'RATE_LIMITED',
      kind: 'unreachable',
    })
    // Gmail rejects the login itself with "too many simultaneous connections".
    expect(
      classifyAccountError({
        authenticationFailed: true,
        serverResponseCode: 'ALERT',
        responseText: 'Too many simultaneous connections. (Failure)',
      }),
    ).toEqual({ code: 'RATE_LIMITED', kind: 'unreachable' })
    expect(classifyAccountError({ authenticationFailed: true })?.code).toBe('AUTH_FAILED')
  })

  it('treats vague throttling phrases as throttling only without an auth failure', () => {
    // A rejected login with "try again later" stays an auth error (no retries
    // with a wrong password).
    expect(
      classifyAccountError({
        authenticationFailed: true,
        responseText: 'Invalid credentials, try again later',
      }),
    ).toEqual({ code: 'AUTH_FAILED', kind: 'auth' })
    expect(
      classifyAccountError({ code: 'EAUTH', response: '454 4.7.0 Rate limit exceeded' })?.code,
    ).toBe('AUTH_FAILED')
    expect(classifyAccountError({ responseText: 'Server busy, try again later' })?.code).toBe(
      'RATE_LIMITED',
    )
    expect(classifyAccountError({ code: 'EENVELOPE', response: '421 4.7.0 Throttled' })?.code).toBe(
      'RATE_LIMITED',
    )
  })
})

describe.skipIf(!databaseUrl || !greenmailHost)('quotas in the job runner', () => {
  let pool: pg.Pool
  let userId: string
  let dataDir: string
  const servers: net.Server[] = []
  const sockets: net.Socket[] = []

  async function listen(server: net.Server, host: string): Promise<number> {
    servers.push(server)
    server.on('connection', (socket) => sockets.push(socket))
    await new Promise<void>((resolve) => server.listen(0, host, resolve))
    return (server.address() as net.AddressInfo).port
  }

  async function createAccount(host: string, port: number, password: string): Promise<string> {
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
       VALUES ($1, $2, 'Quota', $3, $4, $5, $4, 3025, $6, 'v1', $7, 'ok')`,
      [id, userId, process.env.GREENMAIL_USER, host, port, wrappedDek, credentialEnc],
    )
    return id
  }

  async function runningJobs(accountIds: string[]): Promise<number> {
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*) FROM job WHERE state = 'running' AND account_id = ANY($1)`,
      [accountIds],
    )
    return Number(rows[0]!.count)
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl })
    await runMigrations(pool)
    await pool.query(
      'TRUNCATE session, device, "user", mail_account, identity, folder, job, message CASCADE',
    )
    dataDir = await mkdtemp(path.join(tmpdir(), 'fma-quotas-'))
    process.env.MAIL_DATA_DIR = dataDir
    const user = await pool.query<{ id: string }>(
      `INSERT INTO "user" (email, password_hash) VALUES ($1, 'x') RETURNING id`,
      [`quotas-${Date.now()}@example.com`],
    )
    userId = user.rows[0]!.id
  })

  afterAll(async () => {
    for (const socket of sockets) socket.destroy()
    for (const server of servers)
      await new Promise<void>((resolve) => server.close(() => resolve()))
    await pool.query(
      'TRUNCATE session, device, "user", mail_account, identity, folder, job, message CASCADE',
    )
    await pool.end()
    await rm(dataDir, { recursive: true, force: true })
  })

  it.skipIf(!secondLoopback)(
    'never runs more jobs per IMAP host than the limit; other hosts keep syncing',
    async () => {
      // A slow provider on its own loopback address: accepts, never answers.
      const slowPort = await listen(net.createServer(), '127.0.0.2')
      const slow: string[] = []
      for (let i = 0; i < 4; i++) slow.push(await createAccount('127.0.0.2', slowPort, 'x'))
      const healthy = await createAccount(
        greenmailHost!,
        Number(process.env.GREENMAIL_IMAP_PORT),
        process.env.GREENMAIL_PASSWORD!,
      )
      for (const id of [...slow, healthy]) {
        await enqueueJob(pool, { type: 'folder_sync', accountId: id })
      }

      const runner = new JobRunner(pool, {
        concurrency: 5,
        maxConnectionsPerHost: 2,
        timeoutMs: () => 1_500,
      })
      let maxSlow = 0
      const sample = setInterval(() => {
        maxSlow = Math.max(maxSlow, runner.hostJobCounts().get('127.0.0.2') ?? 0)
      }, 10)
      try {
        await runner.fill()
        // Two of the four slow accounts hold the host's slots, the others wait
        // queued (no slot is blocked by waiting); the healthy host is unaffected.
        expect(runner.hostJobCounts().get('127.0.0.2')).toBe(2)
        expect(await runningJobs(slow)).toBe(2)
        expect(await runningJobs([healthy])).toBe(1)
        expect(runner.active).toBe(3)
        await runner.drain()
      } finally {
        clearInterval(sample)
      }
      expect(maxSlow).toBe(2)
      expect(runner.hostJobCounts().size).toBe(0)

      // Every slow account got its turn (timed out, backoff), none was skipped.
      const { rows } = await pool.query<{ account_id: string; last_error_code: string | null }>(
        'SELECT id AS account_id, last_error_code FROM mail_account WHERE id = ANY($1)',
        [slow],
      )
      expect(rows.map((row) => row.last_error_code)).toEqual(Array(4).fill('JOB_TIMEOUT'))
      const healthyState = await pool.query<{ status: string; last_sync_at: Date | null }>(
        'SELECT status, last_sync_at FROM mail_account WHERE id = $1',
        [healthy],
      )
      expect(healthyState.rows[0]).toMatchObject({ status: 'ok' })
      expect(healthyState.rows[0]!.last_sync_at).not.toBeNull()
    },
  )

  it('backs off a throttled account instead of marking it as auth error', async () => {
    // Fake IMAP server that rejects the login like Gmail at its connection limit.
    const throttlePort = await listen(
      net.createServer((socket) => {
        socket.write('* OK IMAP4rev1 ready\r\n')
        let buffer = ''
        socket.on('data', (chunk) => {
          buffer += chunk.toString('latin1')
          let index: number
          while ((index = buffer.indexOf('\r\n')) >= 0) {
            const line = buffer.slice(0, index)
            buffer = buffer.slice(index + 2)
            const [tag, command = ''] = line.split(' ')
            if (!tag) continue
            if (command.toUpperCase() === 'CAPABILITY') {
              socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK done\r\n`)
            } else if (command.toUpperCase() === 'LOGIN') {
              socket.write(`${tag} NO [ALERT] Too many simultaneous connections. (Failure)\r\n`)
            } else if (command.toUpperCase() === 'LOGOUT') {
              socket.end(`* BYE\r\n${tag} OK bye\r\n`)
            } else {
              socket.write(`${tag} BAD unknown\r\n`)
            }
          }
        })
      }),
      '127.0.0.1',
    )
    const throttled = await createAccount('127.0.0.1', throttlePort, 'secret')
    await enqueueJob(pool, { type: 'folder_sync', accountId: throttled })
    await new JobRunner(pool, { concurrency: 1, timeoutMs: () => 10_000 }).drain()

    const { rows } = await pool.query<{
      status: string
      last_error_code: string | null
      next_retry_at: Date | null
    }>('SELECT status, last_error_code, next_retry_at FROM mail_account WHERE id = $1', [throttled])
    expect(rows[0]).toMatchObject({ status: 'ok', last_error_code: 'RATE_LIMITED' })
    expect(rows[0]!.next_retry_at!.getTime()).toBeGreaterThan(Date.now() + 30_000)
    const job = await pool.query<{ state: string; last_error: string | null }>(
      `SELECT state, last_error FROM job WHERE account_id = $1`,
      [throttled],
    )
    // Retried later; only codes are stored, never the provider text.
    expect(job.rows[0]!.state).toBe('queued')
    expect(job.rows[0]!.last_error).not.toMatch(/simultaneous/i)
  })

  it('debounces IDLE-triggered syncs per folder', async () => {
    const accountId = await createAccount('imap.test', 993, 'x')
    const folderId = randomUUID()
    const runAt = async (): Promise<number> => {
      const { rows } = await pool.query<{ delay: number }>(
        `SELECT extract(epoch FROM run_at - now())::float AS delay FROM job
         WHERE type = 'message_sync' AND account_id = $1 AND state = 'queued'`,
        [accountId],
      )
      return rows[0]!.delay
    }

    // First sync of the folder: runs immediately.
    expect(await enqueueMessageSync(pool, accountId, folderId, 10)).toBe(true)
    expect(await runAt()).toBeLessThanOrEqual(0.5)

    // It just ran: the next one waits for the minimum interval.
    await pool.query(`UPDATE job SET state = 'done', locked_at = now() WHERE account_id = $1`, [
      accountId,
    ])
    expect(await enqueueMessageSync(pool, accountId, folderId, 10)).toBe(true)
    const delay = await runAt()
    expect(delay).toBeGreaterThan(8)
    expect(delay).toBeLessThanOrEqual(10.5)

    // Without debounce (folder_sync chain, interval 0): immediately.
    await pool.query(`DELETE FROM job WHERE account_id = $1 AND state = 'queued'`, [accountId])
    expect(await enqueueMessageSync(pool, accountId, folderId)).toBe(true)
    expect(await runAt()).toBeLessThanOrEqual(0.5)
  })
})
