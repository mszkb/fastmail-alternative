/**
 * Auth routes and middleware (ADR-0004, roadmap 1.6):
 * single-user setup on first start, password login with lockout,
 * server-side sessions in an HttpOnly cookie, logout, device management.
 *
 * CSRF (roadmap 6.4): the cookie is SameSite=Strict and every
 * state-changing request must come from the same origin
 * (security/csrf.ts). Session timeouts: see sessions.ts.
 *
 * Password change: requires the current password (same lockout as login),
 * ends all other devices/sessions and rotates the current session token.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import cookies from '@fastify/cookie'
import type { Pool } from '@fma/db'
import { dummyVerify, hashPassword, verifyPassword } from './password'
import { isLockedOut, recordFail, recordSuccess } from './lockout'
import { discardSetupCode, ensureSetupCode, setupCodeMatches } from './setup-code'
import {
  changePasswordAndEndOtherSessions,
  createDeviceWithSession,
  deleteSession,
  listDevices,
  maybeTouchDevice,
  resolveSession,
  revokeDevice,
  rotateSession,
  SESSION_TTL_MS,
  type SessionRow,
} from './sessions'

const COOKIE_NAME = 'fma_session'
const ROTATION_INTERVAL_MS = 24 * 60 * 60_000

/**
 * Secure cookies only when the instance is not plain-HTTP (`DOMAIN=:80`).
 * COOKIE_SECURE=1/0 overrides it, e.g. `1` behind an own TLS proxy that
 * forwards to caddy on :80 (ASVS N7).
 */
export function cookieSecure(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.COOKIE_SECURE === '1') return true
  if (env.COOKIE_SECURE === '0') return false
  return (env.DOMAIN ?? ':80') !== ':80'
}

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

/**
 * Middleware for authenticated routes. Registered as `onRequest` hook (not
 * preHandler), so requests without a valid session are answered with 401
 * before their body is read or parsed.
 */
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
    secure: cookieSecure(),
    maxAge: SESSION_TTL_MS / 1000, // seconds; server-side expiry is authoritative
  })
}

function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(COOKIE_NAME, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: cookieSecure(),
  })
}

/**
 * A login on a browser that still holds a valid session replaces it: the
 * old token is invalidated server-side instead of lingering until expiry.
 */
async function endPreviousSession(request: FastifyRequest): Promise<void> {
  const token = request.cookies[COOKIE_NAME]
  if (!token) return
  const previous = await resolveSession(request.server.authPool, token)
  if (previous) await deleteSession(request.server.authPool, previous.sessionId)
}

/**
 * Security event for a failed login or password change (ASVS 7.1.3).
 * Deliberately without email, password or IP: the request id links it to
 * the access log line, which already carries the client address.
 */
function logAuthFailure(request: FastifyRequest, event: string): void {
  const lockedOut = recordFail(request.ip)
  request.log.warn({ event, lockedOut }, 'authentication failed')
}

interface CredentialsBody {
  email?: string
  password?: string
  deviceName?: string
  platform?: string
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PLATFORMS = new Set(['ios_pwa', 'android_pwa', 'desktop'])

/** Minimum requirements for a new password (setup and password change). */
function isAcceptablePassword(password: string): boolean {
  return password.length >= 10 && password.length <= 200
}

function readCredentials(
  body: CredentialsBody | undefined,
): { email: string; password: string; deviceName: string; platform: string } | null {
  const email = body?.email?.trim().toLowerCase() ?? ''
  const password = body?.password ?? ''
  if (!EMAIL_RE.test(email) || !isAcceptablePassword(password)) return null
  const deviceName = (body?.deviceName ?? 'Browser').trim().slice(0, 100) || 'Browser'
  const platform = PLATFORMS.has(body?.platform ?? '') ? (body?.platform as string) : 'desktop'
  return { email, password, deviceName, platform }
}

/** Arbitrary but fixed advisory lock id that serializes the first-run setup. */
const SETUP_LOCK_ID = 0x2f6d6173n // "fmas"

async function userExists(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query('SELECT EXISTS (SELECT 1 FROM "user") AS exists')
  return rows[0].exists === true
}

/**
 * Creates the single user, unless one exists. Check and insert run in one
 * transaction under an advisory lock, so two parallel setup requests cannot
 * both create a user (ASVS review M1). Returns null if a user exists.
 */
async function insertSingleUser(
  pool: Pool,
  email: string,
  passwordHash: string,
): Promise<string | null> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock($1)', [SETUP_LOCK_ID])
    const { rows } = await client.query('SELECT EXISTS (SELECT 1 FROM "user") AS exists')
    if (rows[0].exists === true) {
      await client.query('ROLLBACK')
      return null
    }
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO "user" (email, password_hash) VALUES ($1, $2) RETURNING id`,
      [email, passwordHash],
    )
    await client.query('COMMIT')
    const userId = inserted.rows[0]?.id
    if (!userId) throw new Error('user insert returned no id')
    return String(userId)
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
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

  app.post<{ Body: CredentialsBody & { setupCode?: unknown } }>(
    '/api/auth/setup',
    async (request, reply) => {
      if (await userExists(pool)) {
        await reply.code(403).send({ message: 'Setup already completed' })
        return
      }
      // A fresh instance is reachable by anyone: only whoever can read the
      // api log (or .env) may claim it (setup-code.ts).
      ensureSetupCode(request.log)
      if (!setupCodeMatches(request.body?.setupCode)) {
        request.log.warn({ event: 'auth.setup_code_invalid' }, 'setup rejected: invalid setup code')
        await reply.code(403).send({ message: 'Invalid setup code' })
        return
      }
      const credentials = readCredentials(request.body)
      if (!credentials) {
        await reply.code(400).send({ message: 'Invalid email or password (min. 10 characters)' })
        return
      }
      // Hash outside the transaction so the lock is held only briefly.
      const passwordHash = await hashPassword(credentials.password)
      const userId = await insertSingleUser(pool, credentials.email, passwordHash)
      if (!userId) {
        await reply.code(403).send({ message: 'Setup already completed' })
        return
      }
      discardSetupCode()
      const { token } = await createDeviceWithSession(
        pool,
        userId,
        credentials.deviceName,
        credentials.platform,
      )
      recordSuccess(request.ip)
      setSessionCookie(reply, token)
      await reply.send({ email: credentials.email })
    },
  )

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
      logAuthFailure(request, 'auth.login_failed')
      await reply.code(401).send({ message: 'Invalid email or password' })
      return
    }

    const userId = await findUserIdByEmail(pool, credentials.email)
    if (!userId) {
      await dummyVerify(credentials.password)
      logAuthFailure(request, 'auth.login_failed')
      await reply.code(401).send({ message: 'Invalid email or password' })
      return
    }

    const { rows } = await pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM "user" WHERE id = $1',
      [userId],
    )
    const passwordHash = rows[0]?.password_hash
    if (!passwordHash || !(await verifyPassword(credentials.password, passwordHash))) {
      logAuthFailure(request, 'auth.login_failed')
      await reply.code(401).send({ message: 'Invalid email or password' })
      return
    }

    recordSuccess(request.ip)
    await endPreviousSession(request)
    const { token } = await createDeviceWithSession(
      pool,
      userId,
      credentials.deviceName,
      credentials.platform,
    )
    setSessionCookie(reply, token)
    await reply.send({ email: credentials.email })
  })

  app.post<{ Body: { currentPassword?: unknown; newPassword?: unknown } }>(
    '/api/auth/password',
    { onRequest: requireAuth },
    async (request, reply) => {
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

      const currentPassword =
        typeof request.body?.currentPassword === 'string' ? request.body.currentPassword : ''
      const newPassword =
        typeof request.body?.newPassword === 'string' ? request.body.newPassword : ''
      const auth = request.auth!

      const { rows } = await pool.query<{ password_hash: string }>(
        'SELECT password_hash FROM "user" WHERE id = $1',
        [auth.userId],
      )
      const passwordHash = rows[0]?.password_hash
      const currentOk =
        passwordHash !== undefined &&
        currentPassword.length > 0 &&
        currentPassword.length <= 200 &&
        (await verifyPassword(currentPassword, passwordHash))
      if (!currentOk) {
        logAuthFailure(request, 'auth.password_change_failed')
        await reply.code(403).send({ message: 'Current password is incorrect' })
        return
      }
      recordSuccess(request.ip)

      if (!isAcceptablePassword(newPassword)) {
        await reply.code(400).send({ message: 'New password must have 10 to 200 characters' })
        return
      }

      const newHash = await hashPassword(newPassword)
      const token = await changePasswordAndEndOtherSessions(
        pool,
        auth.userId,
        auth.sessionId,
        auth.deviceId,
        newHash,
      )
      setSessionCookie(reply, token)
      await reply.code(204).send()
    },
  )

  app.delete('/api/auth/session', { onRequest: requireAuth }, async (request, reply) => {
    await deleteSession(pool, request.auth!.sessionId)
    clearSessionCookie(reply)
    await reply.code(204).send()
  })

  app.get('/api/auth/devices', { onRequest: requireAuth }, async (request, reply) => {
    const devices = await listDevices(pool, request.auth!.userId, request.auth!.deviceId)
    await reply.send({ devices })
  })

  app.delete<{ Params: { id: string } }>(
    '/api/auth/devices/:id',
    { onRequest: requireAuth },
    async (request, reply) => {
      if (request.params.id === request.auth!.deviceId) {
        await reply.code(409).send({ message: 'Cannot revoke the current device; log out instead' })
        return
      }
      // Non-UUID ids cannot exist; answering 404 here keeps Postgres from
      // raising an invalid-input error (500).
      const revoked =
        UUID_RE.test(request.params.id) &&
        (await revokeDevice(pool, request.auth!.userId, request.params.id))
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
