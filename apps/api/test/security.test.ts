/**
 * Hardening tests (roadmap 6.4): rate limits, CSRF origin checks, client IP
 * behind the proxy, security headers and session cookie/timeouts.
 * Requires PostgreSQL (DATABASE_URL), like the auth tests.
 */
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance, InjectOptions } from 'fastify'
import { runMigrations } from '@fma/db/migrate'
import { buildApp } from '../src/app'
import { pool } from '../src/db'
import { isPrivateAddress } from '../src/security/client-ip'
import { RateLimiter } from '../src/security/rate-limit'

/** Setup code configured for the tests (vitest.config.ts). */
const SETUP_CODE = 'test-setup-code'

const databaseUrl = process.env.DATABASE_URL
const EMAIL = 'hardening@example.com'
const PASSWORD = 'correct horse battery'
const HOST = 'mail.example.com'

let app: FastifyInstance

let ipCounter = 0
function ip(): string {
  ipCounter += 1
  return `10.98.0.${ipCounter}`
}

function login(opts: { ip?: string; headers?: Record<string, string>; app?: FastifyInstance }) {
  return (opts.app ?? app).inject({
    method: 'POST',
    url: '/api/auth/login',
    remoteAddress: opts.ip ?? ip(),
    headers: { host: HOST, 'content-type': 'application/json', ...opts.headers },
    payload: JSON.stringify({ email: EMAIL, password: PASSWORD, deviceName: 'Hardening' }),
  })
}

function sessionCookie(res: Awaited<ReturnType<typeof login>>) {
  const cookie = res.cookies.find((c) => c.name === 'fma_session')
  if (!cookie) throw new Error('no session cookie set')
  return cookie
}

function hashOf(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest()
}

async function status(token: string) {
  const res = await app.inject({
    method: 'GET',
    url: '/api/auth/status',
    remoteAddress: ip(),
    headers: { cookie: `fma_session=${token}` },
  })
  return res.json() as { authenticated: boolean }
}

describe('rate limiter (unit)', () => {
  it('counts per rule and IP within a fixed window', () => {
    const limiter = new RateLimiter([{ name: 'r', max: 2, method: 'POST', routes: ['/x'] }])
    const t = 1_000_000
    expect(limiter.hit('POST', '/x', 'a', t)).toBe(0)
    expect(limiter.hit('POST', '/x', 'a', t)).toBe(0)
    expect(limiter.hit('POST', '/x', 'a', t + 1000)).toBe(59)
    expect(limiter.hit('POST', '/x', 'b', t)).toBe(0) // other IP
    expect(limiter.hit('GET', '/x', 'a', t)).toBe(0) // other method
    expect(limiter.hit('POST', '/x', 'a', t + 60_000)).toBe(0) // new window
  })

  it('classifies private proxy addresses', () => {
    expect(isPrivateAddress('172.18.0.3')).toBe(true)
    expect(isPrivateAddress('::ffff:10.1.2.3')).toBe(true)
    expect(isPrivateAddress('::1')).toBe(true)
    expect(isPrivateAddress('203.0.113.9')).toBe(false)
    expect(isPrivateAddress('2001:db8::1')).toBe(false)
  })
})

describe.skipIf(!databaseUrl)('hardening (roadmap 6.4)', () => {
  beforeAll(async () => {
    app = buildApp({ logger: false })
    await runMigrations(pool)
    await pool.query('TRUNCATE session, device, "user" CASCADE')
    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      remoteAddress: ip(),
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ setupCode: SETUP_CODE, email: EMAIL, password: PASSWORD }),
    })
    expect(setup.statusCode).toBe(200)
  })

  afterAll(async () => {
    await pool.query('TRUNCATE session, device, "user" CASCADE')
    await pool.end()
  })

  describe('rate limits', () => {
    it('answers 429 with Retry-After once a route limit is exceeded', async () => {
      const limited = buildApp({
        logger: false,
        rateLimits: [{ name: 'auth', max: 3, method: 'POST', routes: ['/api/auth/login'] }],
      })
      const client = ip()
      for (let i = 0; i < 3; i += 1) {
        expect((await login({ app: limited, ip: client })).statusCode).toBe(200)
      }
      const blocked = await login({ app: limited, ip: client })
      expect(blocked.statusCode).toBe(429)
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0)
      // Other clients are not affected.
      expect((await login({ app: limited })).statusCode).toBe(200)
      await limited.close()
    })

    it('limits login attempts by default (10 per minute and IP)', async () => {
      const client = ip()
      const codes: number[] = []
      for (let i = 0; i < 11; i += 1) codes.push((await login({ ip: client })).statusCode)
      expect(codes.slice(0, 10).every((code) => code === 200)).toBe(true)
      expect(codes[10]).toBe(429)
    })

    it('cannot be bypassed by a spoofed X-Forwarded-For from a public client', async () => {
      const limited = buildApp({ logger: false, rateLimits: [{ name: 'global', max: 2 }] })
      const codes: number[] = []
      for (let i = 0; i < 3; i += 1) {
        const res = await limited.inject({
          method: 'GET',
          url: '/api/auth/status',
          remoteAddress: '203.0.113.7',
          headers: { 'x-forwarded-for': `198.51.100.${i}` },
        })
        codes.push(res.statusCode)
      }
      expect(codes).toEqual([200, 200, 429])
      await limited.close()
    })

    it('uses the client IP forwarded by the private reverse proxy', async () => {
      const limited = buildApp({ logger: false, rateLimits: [{ name: 'global', max: 1 }] })
      const viaProxy = (forwardedFor: string) =>
        limited.inject({
          method: 'GET',
          url: '/api/auth/status',
          remoteAddress: '172.18.0.5', // caddy in the compose network
          headers: { 'x-forwarded-for': forwardedFor },
        })
      expect((await viaProxy('198.51.100.1')).statusCode).toBe(200)
      expect((await viaProxy('198.51.100.2')).statusCode).toBe(200) // other client
      expect((await viaProxy('198.51.100.1')).statusCode).toBe(429)
      // A client-supplied left-most entry is ignored: only the address the
      // proxy appended counts.
      expect((await viaProxy('1.2.3.4, 198.51.100.1')).statusCode).toBe(429)
      await limited.close()
    })
  })

  describe('CSRF', () => {
    it('rejects state-changing requests from a foreign origin', async () => {
      const evil = await login({ headers: { origin: 'https://evil.example' } })
      expect(evil.statusCode).toBe(403)
      expect(evil.cookies).toHaveLength(0)

      const crossSite = await login({ headers: { 'sec-fetch-site': 'cross-site' } })
      expect(crossSite.statusCode).toBe(403)
      // A sibling subdomain is not trusted either.
      const sameSite = await login({ headers: { 'sec-fetch-site': 'same-site' } })
      expect(sameSite.statusCode).toBe(403)
      const nullOrigin = await login({ headers: { origin: 'null' } })
      expect(nullOrigin.statusCode).toBe(403)
    })

    it('accepts same-origin requests', async () => {
      expect((await login({ headers: { 'sec-fetch-site': 'same-origin' } })).statusCode).toBe(200)
      expect((await login({ headers: { origin: `https://${HOST}` } })).statusCode).toBe(200)
      // Sec-Fetch-Site wins over Origin (dev proxy rewrites the Host header).
      expect(
        (
          await login({
            headers: { 'sec-fetch-site': 'same-origin', origin: 'http://localhost:3000' },
          })
        ).statusCode,
      ).toBe(200)
      // Non-browser clients (no Origin, no Sec-Fetch-Site) are allowed.
      expect((await login({})).statusCode).toBe(200)
    })

    it('protects uploads and deletes before authentication or body parsing', async () => {
      const token = sessionCookie(await login({})).value
      const upload = await app.inject({
        method: 'POST',
        url: '/api/accounts/00000000-0000-0000-0000-000000000000/uploads',
        remoteAddress: ip(),
        headers: {
          host: HOST,
          origin: 'https://evil.example',
          cookie: `fma_session=${token}`,
          'content-type': 'application/octet-stream',
          'x-filename': 'a.txt',
        },
        payload: Buffer.from('hello'),
      })
      expect(upload.statusCode).toBe(403)

      const logout = await app.inject({
        method: 'DELETE',
        url: '/api/auth/session',
        remoteAddress: ip(),
        headers: { host: HOST, 'sec-fetch-site': 'cross-site', cookie: `fma_session=${token}` },
      })
      expect(logout.statusCode).toBe(403)
      expect((await status(token)).authenticated).toBe(true)
    })

    it('leaves safe methods alone', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/status',
        remoteAddress: ip(),
        headers: { host: HOST, 'sec-fetch-site': 'cross-site' },
      } satisfies InjectOptions)
      expect(res.statusCode).toBe(200)
    })
  })

  describe('security headers', () => {
    it('sets restrictive defaults on api responses', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/auth/status', remoteAddress: ip() })
      expect(res.headers['content-security-policy']).toContain("default-src 'none'")
      expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'")
      expect(res.headers['x-content-type-options']).toBe('nosniff')
      expect(res.headers['x-frame-options']).toBe('DENY')
      expect(res.headers['referrer-policy']).toBe('no-referrer')
      expect(res.headers['cache-control']).toBe('no-store')
    })

    it('also applies to error responses', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/nope', remoteAddress: ip() })
      expect(res.statusCode).toBe(404)
      expect(res.headers['x-content-type-options']).toBe('nosniff')
    })
  })

  describe('session hardening', () => {
    it('sets the session cookie HttpOnly, SameSite=Strict, Path=/ and with max-age', async () => {
      const cookie = sessionCookie(await login({}))
      expect(cookie.httpOnly).toBe(true)
      expect(cookie.sameSite).toBe('Strict')
      expect(cookie.path).toBe('/')
      expect(cookie.maxAge).toBe(30 * 24 * 60 * 60)
      expect(cookie.secure).toBeFalsy() // DOMAIN unset = plain-HTTP instance
    })

    it('marks the cookie Secure on a TLS instance', async () => {
      const previous = process.env.DOMAIN
      process.env.DOMAIN = HOST
      try {
        expect(sessionCookie(await login({})).secure).toBe(true)
      } finally {
        if (previous === undefined) delete process.env.DOMAIN
        else process.env.DOMAIN = previous
      }
    })

    it('replaces a still valid session on login (old token invalidated)', async () => {
      const first = sessionCookie(await login({})).value
      const second = await login({ headers: { cookie: `fma_session=${first}` } })
      const secondToken = sessionCookie(second).value
      expect(secondToken).not.toBe(first)
      expect((await status(first)).authenticated).toBe(false)
      expect((await status(secondToken)).authenticated).toBe(true)
    })

    it('ends idle sessions after 14 days without activity', async () => {
      const token = sessionCookie(await login({})).value
      await pool.query(
        `UPDATE session SET rotated_at = now() - interval '13 days' WHERE token_hash = $1`,
        [hashOf(token)],
      )
      // Still valid (and rotated, since older than 24 hours).
      const active = await app.inject({
        method: 'GET',
        url: '/api/auth/status',
        remoteAddress: ip(),
        headers: { cookie: `fma_session=${token}` },
      })
      expect(active.json().authenticated).toBe(true)
      const rotated = active.cookies.find((c) => c.name === 'fma_session')!.value

      await pool.query(
        `UPDATE session SET rotated_at = now() - interval '15 days' WHERE token_hash = $1`,
        [hashOf(rotated)],
      )
      expect((await status(rotated)).authenticated).toBe(false)
    })

    it('ends sessions at the absolute expiry even when active', async () => {
      const token = sessionCookie(await login({})).value
      await pool.query(
        `UPDATE session SET expires_at = now() - interval '1 second' WHERE token_hash = $1`,
        [hashOf(token)],
      )
      expect((await status(token)).authenticated).toBe(false)
    })

    it('logout deletes the session server-side and expires the cookie', async () => {
      const token = sessionCookie(await login({})).value
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/auth/session',
        remoteAddress: ip(),
        headers: { host: HOST, 'sec-fetch-site': 'same-origin', cookie: `fma_session=${token}` },
      })
      expect(res.statusCode).toBe(204)
      const cleared = res.cookies.find((c) => c.name === 'fma_session')!
      expect(cleared.value).toBe('')
      expect(cleared.httpOnly).toBe(true)
      const { rows } = await pool.query('SELECT 1 FROM session WHERE token_hash = $1', [
        hashOf(token),
      ])
      expect(rows).toHaveLength(0)
    })
  })
})
