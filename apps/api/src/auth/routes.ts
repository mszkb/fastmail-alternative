/**
 * Auth routes and middleware (ADR-0004, roadmap 1.6):
 * single-user setup on first start, password login with lockout,
 * server-side sessions in an HttpOnly cookie, logout, device management.
 *
 * CSRF: the cookie is SameSite=Strict, which covers the MVP surface;
 * dedicated CSRF tokens follow in 6.4 (hardening) per ADR-0004.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import cookies from '@fastify/cookie'
import type { Pool } from '@fma/db'
import { dummyVerify, hashPassword, verifyPassword } from './password'
import { isLockedOut, recordFail, recordSuccess } from './lockout'
import {
  createDeviceWithSession,
  deleteSession,
  listDevices,
  maybeTouchDevice,
  resolveSession,
  revokeDevice,
  rotateSession,
  type SessionRow,
} from './sessions'

const COOKIE_NAME = 'fma_session'
const ROTATION_INTERVAL_MS = 24 * 60 * 60_000

/** Secure cookies only when the instance is not plain-HTTP (`DOMAIN=:80`). */
const COOKIE_SECURE = (process.env.DOMAIN ?? ':80') !== ':80'

declare module 'fastify' {
  interface FastifyRequest {
    auth?: {
      userId: string
      email: string
      sessionId: string
      deviceId: string
      tokenIssuedAt: Date
    }
  }
  interface FastifyInstance {
    authPool: Pool
  }
}

/**
 * Resolves the session from the cookie and rotates the token when it is
 * older than the rotation interval (the new cookie is set on the reply).
 * Returns null when unauthenticated.
 */
async function resolveWithRotation(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<SessionRow | null> {
  const token = request.cookies[COOKIE_NAME]
  if (!token) return null
  const session = await resolveSession(request.server.authPool, token)
  if (!session) return null

  request.auth = session
  maybeTouchDevice(request.server.authPool, session.deviceId)

  if (Date.now() - session.tokenIssuedAt.getTime() > ROTATION_INTERVAL_MS) {
    const newToken = await rotateSession(request.server.authPool, session.sessionId)
    setSessionCookie(reply, newToken)
  }
  return session
}

/** Middleware for authenticated routes. */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const session = await resolveWithRotation(request, reply)
  if (!session) {
    await reply.code(401).send({ message: 'Not authenticated' })
  }
}

function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(COOKIE_NAME, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: COOKIE_SECURE,
    maxAge: 30 * 24 * 60 * 60, // seconds; server-side expiry is authoritative
  })
}

function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(COOKIE_NAME, { path: '/' })
}

interface CredentialsBody {
  email?: string
  password?: string
  deviceName?: string
  platform?: string
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PLATFORMS = new Set(['ios_pwa', 'android_pwa', 'desktop'])

function readCredentials(
  body: CredentialsBody | undefined,
): { email: string; password: string; deviceName: string; platform: string } | null {
  const email = body?.email?.trim().toLowerCase() ?? ''
  const password = body?.password ?? ''
  if (!EMAIL_RE.test(email) || password.length < 10 || password.length > 200) return null
  const deviceName = (body?.deviceName ?? 'Browser').trim().slice(0, 100) || 'Browser'
  const platform = PLATFORMS.has(body?.platform ?? '') ? (body?.platform as string) : 'desktop'
  return { email, password, deviceName, platform }
}

/** Single user, so an email mismatch gets the same timing as a password check. */
async function findUserIdByEmail(pool: Pool, email: string): Promise<string | null> {
  const { rows } = await pool.query('SELECT id FROM "user" WHERE email = $1', [email])
  return rows[0] ? String(rows[0].id) : null
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const pool = app.authPool

  app.get('/api/auth/status', async (request, reply) => {
    const { rows } = await pool.query('SELECT count(*)::int AS count FROM "user"')
    const needsSetup = rows[0].count === 0
    const session = await resolveWithRotation(request, reply)
    await reply.send({
      needsSetup,
      authenticated: session !== null,
      ...(session ? { email: session.email } : {}),
    })
  })

  app.post<{ Body: CredentialsBody }>('/api/auth/setup', async (request, reply) => {
    const credentials = readCredentials(request.body)
    if (!credentials) {
      await reply.code(400).send({ message: 'Invalid email or password (min. 10 characters)' })
      return
    }
    const { rows } = await pool.query('SELECT count(*)::int AS count FROM "user"')
    if (rows[0].count > 0) {
      await reply.code(403).send({ message: 'Setup already completed' })
      return
    }
    const passwordHash = await hashPassword(credentials.password)
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO "user" (email, password_hash) VALUES ($1, $2) RETURNING id`,
      [credentials.email, passwordHash],
    )
    const userId = inserted.rows[0]?.id
    if (!userId) throw new Error('user insert returned no id')
    const { token } = await createDeviceWithSession(
      pool,
      String(userId),
      credentials.deviceName,
      credentials.platform,
    )
    recordSuccess(request.ip)
    setSessionCookie(reply, token)
    await reply.send({ email: credentials.email })
  })

  app.post<{ Body: CredentialsBody }>('/api/auth/login', async (request, reply) => {
    const lockSeconds = isLockedOut(request.ip)
    if (lockSeconds > 0) {
      await reply
        .code(429)
        .header('retry-after', String(lockSeconds))
        .send({
          message: `Too many failed attempts. Try again in ${Math.ceil(lockSeconds / 60)} minutes.`,
        })
      return
    }

    const credentials = readCredentials(request.body)
    if (!credentials) {
      recordFail(request.ip)
      await reply.code(401).send({ message: 'Invalid email or password' })
      return
    }

    const userId = await findUserIdByEmail(pool, credentials.email)
    if (!userId) {
      await dummyVerify(credentials.password)
      recordFail(request.ip)
      await reply.code(401).send({ message: 'Invalid email or password' })
      return
    }

    const { rows } = await pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM "user" WHERE id = $1',
      [userId],
    )
    const passwordHash = rows[0]?.password_hash
    if (!passwordHash || !(await verifyPassword(credentials.password, passwordHash))) {
      recordFail(request.ip)
      await reply.code(401).send({ message: 'Invalid email or password' })
      return
    }

    recordSuccess(request.ip)
    const { token } = await createDeviceWithSession(
      pool,
      userId,
      credentials.deviceName,
      credentials.platform,
    )
    setSessionCookie(reply, token)
    await reply.send({ email: credentials.email })
  })

  app.delete('/api/auth/session', { preHandler: requireAuth }, async (request, reply) => {
    await deleteSession(pool, request.auth!.sessionId)
    clearSessionCookie(reply)
    await reply.code(204).send()
  })

  app.get('/api/auth/devices', { preHandler: requireAuth }, async (request, reply) => {
    const devices = await listDevices(pool, request.auth!.userId, request.auth!.deviceId)
    await reply.send({ devices })
  })

  app.delete<{ Params: { id: string } }>(
    '/api/auth/devices/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      if (request.params.id === request.auth!.deviceId) {
        await reply.code(409).send({ message: 'Cannot revoke the current device; log out instead' })
        return
      }
      const revoked = await revokeDevice(pool, request.auth!.userId, request.params.id)
      if (!revoked) {
        await reply.code(404).send({ message: 'Device not found' })
        return
      }
      await reply.code(204).send()
    },
  )
}

/** Registers cookie parsing and the auth routes with the shared pool. */
export function registerAuth(app: FastifyInstance, pool: Pool): void {
  app.decorate('authPool', pool)
  app.register(cookies)
  app.register(authRoutes)
}
