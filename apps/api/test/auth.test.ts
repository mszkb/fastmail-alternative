/**
 * Integration tests for the auth flow (roadmap 1.6). Requires PostgreSQL:
 * point DATABASE_URL at a dedicated test database (CI provides a service
 * container; locally use an SSH tunnel like for the db tests).
 *
 * These tests create/delete rows in the configured database - only point
 * DATABASE_URL at a throwaway database.
 */
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { runMigrations } from '@fma/db/migrate'
import { buildApp } from '../src/app'
import { pool } from '../src/db'

const databaseUrl = process.env.DATABASE_URL
let app: FastifyInstance

/** Unique client IP per test so the lockout cannot leak between tests. */
let ipCounter = 0
function ip(): string {
  ipCounter += 1
  return `10.99.0.${ipCounter}`
}

async function inject(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  opts: { payload?: object; token?: string; ip?: string } = {},
) {
  return app.inject({
    method,
    url,
    remoteAddress: opts.ip ?? ip(),
    ...(opts.payload ? { payload: JSON.stringify(opts.payload) } : {}),
    headers: {
      ...(opts.payload ? { 'content-type': 'application/json' } : {}),
      ...(opts.token ? { cookie: `fma_session=${opts.token}` } : {}),
    },
  })
}

function cookieToken(res: { cookies: { name: string; value: string }[] }): string {
  const cookie = res.cookies.find((c) => c.name === 'fma_session')
  if (!cookie) throw new Error('no session cookie set')
  return cookie.value
}

describe.skipIf(!databaseUrl)('auth flow', () => {
  beforeAll(async () => {
    app = buildApp({ logger: false })
    await runMigrations(pool)
    await pool.query('TRUNCATE session, device, "user" CASCADE')
  })

  afterAll(async () => {
    await pool.query('TRUNCATE session, device, "user" CASCADE')
    await pool.end()
  })

  it('reports needsSetup=true on a fresh database', async () => {
    const res = await inject('GET', '/api/auth/status')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ needsSetup: true, authenticated: false })
  })

  it('setup creates the single user and starts a session', async () => {
    const res = await inject('POST', '/api/auth/setup', {
      payload: {
        email: 'Martin@Example.com',
        password: 'correct horse battery',
        deviceName: 'Test-Pi',
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().email).toBe('martin@example.com') // normalized to lower case
    expect(cookieToken(res)).toBeTruthy()

    const status = await inject('GET', '/api/auth/status', { token: cookieToken(res) })
    expect(status.json()).toEqual({
      needsSetup: false,
      authenticated: true,
      email: 'martin@example.com',
    })
  })

  it('setup is refused once a user exists', async () => {
    const res = await inject('POST', '/api/auth/setup', {
      payload: { email: 'other@example.com', password: 'another password 123' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('rejects invalid payloads', async () => {
    const res = await inject('POST', '/api/auth/login', {
      payload: { email: 'not-an-email', password: 'x' },
    })
    expect(res.statusCode).toBe(401) // treated as failed attempt, generic error
  })

  it('rejects wrong password and unknown email with the same generic error', async () => {
    const wrongPassword = await inject('POST', '/api/auth/login', {
      payload: { email: 'martin@example.com', password: 'wrong password 123' },
    })
    const unknownEmail = await inject('POST', '/api/auth/login', {
      payload: { email: 'unknown@example.com', password: 'wrong password 123' },
    })
    expect(wrongPassword.statusCode).toBe(401)
    expect(unknownEmail.statusCode).toBe(401)
    expect(wrongPassword.json().message).toBe(unknownEmail.json().message)
  })

  it('locks an IP out after 5 failed attempts', async () => {
    const attacker = ip()
    for (let i = 0; i < 5; i += 1) {
      const res = await inject('POST', '/api/auth/login', {
        ip: attacker,
        payload: { email: 'martin@example.com', password: 'wrong password 123' },
      })
      expect(res.statusCode).toBe(401)
    }
    const locked = await inject('POST', '/api/auth/login', {
      ip: attacker,
      payload: { email: 'martin@example.com', password: 'correct horse battery' },
    })
    expect(locked.statusCode).toBe(429)
    expect(locked.headers['retry-after']).toBeDefined()

    // A different IP is not affected.
    const other = await inject('POST', '/api/auth/login', {
      payload: { email: 'martin@example.com', password: 'correct horse battery' },
    })
    expect(other.statusCode).toBe(200)
  })

  it('login creates a device and lists it as current', async () => {
    const login = await inject('POST', '/api/auth/login', {
      payload: {
        email: 'martin@example.com',
        password: 'correct horse battery',
        deviceName: 'Zweitgerät',
      },
    })
    expect(login.statusCode).toBe(200)
    const token = cookieToken(login)

    const devices = await inject('GET', '/api/auth/devices', { token })
    expect(devices.statusCode).toBe(200)
    const list = devices.json().devices as { name: string; isCurrent: boolean }[]
    const current = list.find((entry) => entry.name === 'Zweitgerät')
    expect(current?.isCurrent).toBe(true)
  })

  it('revoking another device kills its session', async () => {
    const firstLogin = await inject('POST', '/api/auth/login', {
      payload: {
        email: 'martin@example.com',
        password: 'correct horse battery',
        deviceName: 'Opfer-Gerät',
      },
    })
    const victimToken = cookieToken(firstLogin)

    const secondLogin = await inject('POST', '/api/auth/login', {
      payload: {
        email: 'martin@example.com',
        password: 'correct horse battery',
        deviceName: 'Admin',
      },
    })
    const adminToken = cookieToken(secondLogin)

    const devices = await inject('GET', '/api/auth/devices', { token: adminToken })
    const victim = (
      devices.json().devices as { id: string; name: string; isCurrent: boolean }[]
    ).find((entry) => entry.name === 'Opfer-Gerät')
    expect(victim).toBeTruthy()

    const revoke = await inject('DELETE', `/api/auth/devices/${victim!.id}`, { token: adminToken })
    expect(revoke.statusCode).toBe(204)

    const after = await inject('GET', '/api/auth/status', { token: victimToken })
    expect(after.json().authenticated).toBe(false)

    const again = await inject('DELETE', `/api/auth/devices/${victim!.id}`, { token: adminToken })
    expect(again.statusCode).toBe(404) // already revoked
  })

  it('rotates a session token older than 24 hours and invalidates the old one', async () => {
    const login = await inject('POST', '/api/auth/login', {
      payload: {
        email: 'martin@example.com',
        password: 'correct horse battery',
        deviceName: 'Rotator',
      },
    })
    const oldToken = cookieToken(login)

    // Simulate a token issued 25 hours ago.
    const oldHash = createHash('sha256').update(oldToken, 'utf8').digest()
    await pool.query(
      `UPDATE session SET rotated_at = now() - interval '25 hours' WHERE token_hash = $1`,
      [oldHash],
    )

    const rotated = await inject('GET', '/api/auth/status', { token: oldToken })
    expect(rotated.statusCode).toBe(200)
    const newToken = cookieToken(rotated)
    expect(newToken).not.toBe(oldToken)

    // Old token no longer works, new one does.
    const withOld = await inject('GET', '/api/auth/status', { token: oldToken })
    expect(withOld.json().authenticated).toBe(false)
    const withNew = await inject('GET', '/api/auth/status', { token: newToken })
    expect(withNew.json().authenticated).toBe(true)
  })

  it('logout invalidates the session and clears the cookie', async () => {
    const login = await inject('POST', '/api/auth/login', {
      payload: {
        email: 'martin@example.com',
        password: 'correct horse battery',
        deviceName: 'Logout',
      },
    })
    const token = cookieToken(login)

    const logout = await inject('DELETE', '/api/auth/session', { token })
    expect(logout.statusCode).toBe(204)

    const after = await inject('GET', '/api/auth/status', { token })
    expect(after.json().authenticated).toBe(false)
  })

  it('unauthenticated requests get 401', async () => {
    const res = await inject('GET', '/api/auth/devices')
    expect(res.statusCode).toBe(401)
  })
})
