/**
 * First-run setup hardening and the central error handler (ASVS review M1,
 * N3). Requires PostgreSQL (DATABASE_URL, throwaway database).
 */
import { PassThrough } from 'node:stream'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { runMigrations } from '@fma/db/migrate'
import { buildApp } from '../src/app'
import { pool } from '../src/db'

/** Setup code configured for the tests (vitest.config.ts). */
const SETUP_CODE = 'test-setup-code'
const EMAIL = 'setup@example.com'
const PASSWORD = 'correct horse battery'

const databaseUrl = process.env.DATABASE_URL
let app: FastifyInstance
let logLines: string[] = []

let ipCounter = 0
function ip(): string {
  ipCounter += 1
  return `10.98.0.${ipCounter}`
}

async function post(url: string, payload: object, token?: string) {
  return app.inject({
    method: 'POST',
    url,
    remoteAddress: ip(),
    payload: JSON.stringify(payload),
    headers: {
      'content-type': 'application/json',
      ...(token ? { cookie: `fma_session=${token}` } : {}),
    },
  })
}

async function userCount(): Promise<number> {
  const { rows } = await pool.query('SELECT count(*)::int AS count FROM "user"')
  return rows[0].count as number
}

describe.skipIf(!databaseUrl)('first-run setup and error handling', () => {
  beforeAll(async () => {
    const stream = new PassThrough()
    stream.on('data', (chunk: Buffer) => logLines.push(...chunk.toString('utf8').split('\n')))
    app = buildApp({ logStream: stream, rateLimits: [] })
    await runMigrations(pool)
  })

  beforeEach(async () => {
    await pool.query('TRUNCATE session, device, "user" CASCADE')
    logLines = []
  })

  afterAll(async () => {
    await pool.query('TRUNCATE session, device, "user" CASCADE')
    await app.close()
    await pool.end()
  })

  it('refuses setup without or with a wrong setup code (403)', async () => {
    const missing = await post('/api/auth/setup', { email: EMAIL, password: PASSWORD })
    expect(missing.statusCode).toBe(403)
    const wrong = await post('/api/auth/setup', {
      setupCode: 'wrong-code',
      email: EMAIL,
      password: PASSWORD,
    })
    expect(wrong.statusCode).toBe(403)
    expect(await userCount()).toBe(0)

    const ok = await post('/api/auth/setup', {
      setupCode: SETUP_CODE,
      email: EMAIL,
      password: PASSWORD,
    })
    expect(ok.statusCode).toBe(200)
    expect(await userCount()).toBe(1)
  })

  it('creates exactly one user for parallel setup requests', async () => {
    const results = await Promise.all(
      ['a', 'b', 'c', 'd'].map((name) =>
        post('/api/auth/setup', {
          setupCode: SETUP_CODE,
          email: `${name}@example.com`,
          password: PASSWORD,
        }),
      ),
    )
    const codes = results.map((res) => res.statusCode).sort()
    expect(codes).toEqual([200, 403, 403, 403])
    expect(await userCount()).toBe(1)
  })

  it('logs a generated setup code once when no SETUP_TOKEN is configured', async () => {
    const configured = process.env.SETUP_TOKEN
    delete process.env.SETUP_TOKEN
    try {
      const first = await post('/api/auth/setup', { email: EMAIL, password: PASSWORD })
      expect(first.statusCode).toBe(403)
      const codeLines = logLines.filter((line) => line.includes('FIRST-RUN SETUP CODE'))
      expect(codeLines).toHaveLength(1)
      const code = /CODE: ([A-Z2-7]{4}(?:-[A-Z2-7]{4}){5})/.exec(codeLines[0]!)?.[1]
      expect(code).toBeTruthy()

      // Case-insensitive, dashes optional; the code is not logged again.
      const ok = await post('/api/auth/setup', {
        setupCode: code!.toLowerCase().replaceAll('-', ' '),
        email: EMAIL,
        password: PASSWORD,
      })
      expect(ok.statusCode).toBe(200)
      expect(logLines.filter((line) => line.includes('FIRST-RUN SETUP CODE'))).toHaveLength(1)
    } finally {
      process.env.SETUP_TOKEN = configured
    }
  })

  it('logs failed logins as security event without email or password', async () => {
    await post('/api/auth/setup', { setupCode: SETUP_CODE, email: EMAIL, password: PASSWORD })
    logLines = []
    const res = await post('/api/auth/login', { email: EMAIL, password: 'wrong password 123' })
    expect(res.statusCode).toBe(401)
    const events = logLines.filter((line) => line.includes('auth.login_failed'))
    expect(events).toHaveLength(1)
    expect(events[0]).not.toContain(EMAIL)
    expect(events[0]).not.toContain('wrong password')
  })

  it('answers non-UUID device ids with 404 and malformed account bodies with 400', async () => {
    const setup = await post('/api/auth/setup', {
      setupCode: SETUP_CODE,
      email: EMAIL,
      password: PASSWORD,
    })
    const token = setup.cookies.find((c) => c.name === 'fma_session')!.value

    const revoke = await app.inject({
      method: 'DELETE',
      url: '/api/auth/devices/not-a-uuid',
      remoteAddress: ip(),
      headers: { cookie: `fma_session=${token}` },
    })
    expect(revoke.statusCode).toBe(404)

    const account = await post(
      '/api/accounts',
      {
        emailAddress: 'x@example.com',
        imap: { host: 1, port: 993, user: 'x', password: 'y' },
        smtp: { host: 'smtp.example.com', port: 465 },
      },
      token,
    )
    expect(account.statusCode).toBe(400)
  })
})

describe('central error handler', () => {
  it('hides internal error messages behind a generic 500', async () => {
    const lines: string[] = []
    const stream = new PassThrough()
    stream.on('data', (chunk: Buffer) => lines.push(chunk.toString('utf8')))
    const local = buildApp({ logStream: stream })
    local.get('/api/test-boom', async () => {
      throw new Error('secret detail from the database')
    })

    const res = await local.inject({ method: 'GET', url: '/api/test-boom' })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ message: 'Internal error' })
    expect(lines.join('')).not.toContain('secret detail')
    await local.close()
  })

  it('answers client errors with a generic text for the status', async () => {
    const local = buildApp({ logger: false })
    local.post('/api/test-json', async () => ({ ok: true }))
    const res = await local.inject({
      method: 'POST',
      url: '/api/test-json',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ message: 'Bad Request' })
    await local.close()
  })
})
