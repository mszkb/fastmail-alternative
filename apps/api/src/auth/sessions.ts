/**
 * Server-side sessions on the session/device tables (ADR-0004).
 *
 * - The cookie carries a random token; only its SHA-256 hash is stored.
 * - Every session belongs to a device; revoking a device kills its sessions.
 * - Rotation: when a token is older than ROTATION_INTERVAL, the next
 *   authenticated request issues a new token and invalidates the old one.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { Pool } from '@fma/db'

const SESSION_TTL_MS = 30 * 24 * 60 * 60_000 // 30 days

export interface SessionRow {
  sessionId: string
  deviceId: string
  userId: string
  email: string
  tokenIssuedAt: Date
}

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest()
}

export function generateToken(): string {
  return randomBytes(32).toString('base64url')
}

/** Creates a device for the user and an initial session for it. */
export async function createDeviceWithSession(
  pool: Pool,
  userId: string,
  deviceName: string,
  platform: string,
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateToken()
  const device = await pool.query<{ id: string }>(
    `INSERT INTO device (user_id, name, platform, installation_id, last_seen_at)
     VALUES ($1, $2, $3, gen_random_uuid(), now()) RETURNING id`,
    [userId, deviceName, platform],
  )
  const deviceId = device.rows[0]?.id
  if (!deviceId) throw new Error('device insert returned no id')
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
  await pool.query(
    `INSERT INTO session (device_id, token_hash, expires_at, rotated_at)
     VALUES ($1, $2, $3, now())`,
    [deviceId, hashToken(token), expiresAt],
  )
  return { token, expiresAt }
}

/** Resolves a token to its session; rejects expired sessions and revoked devices. */
export async function resolveSession(pool: Pool, token: string): Promise<SessionRow | null> {
  const { rows } = await pool.query(
    `SELECT s.id AS session_id, s.rotated_at, d.id AS device_id, u.id AS user_id, u.email
     FROM session s
     JOIN device d ON d.id = s.device_id
     JOIN "user" u ON u.id = d.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND d.revoked_at IS NULL`,
    [hashToken(token)],
  )
  const row = rows[0]
  if (!row) return null
  return {
    sessionId: String(row.session_id),
    deviceId: String(row.device_id),
    userId: String(row.user_id),
    email: String(row.email),
    tokenIssuedAt: new Date(row.rotated_at as string),
  }
}

/** Issues a new token for the session and invalidates the old one. */
export async function rotateSession(pool: Pool, sessionId: string): Promise<string> {
  const token = generateToken()
  await pool.query(`UPDATE session SET token_hash = $2, rotated_at = now() WHERE id = $1`, [
    sessionId,
    hashToken(token),
  ])
  return token
}

/**
 * Logout. A device without sessions is never used again (every login
 * creates a new device), so its push subscriptions go as well: a logged-out
 * browser gets no more notifications.
 */
export async function deleteSession(pool: Pool, sessionId: string): Promise<void> {
  const { rows } = await pool.query<{ device_id: string }>(
    'DELETE FROM session WHERE id = $1 RETURNING device_id',
    [sessionId],
  )
  const deviceId = rows[0]?.device_id
  if (!deviceId) return
  await pool.query(
    `DELETE FROM push_subscription
     WHERE device_id = $1 AND NOT EXISTS (SELECT 1 FROM session WHERE device_id = $1)`,
    [deviceId],
  )
}

export interface DeviceInfo {
  id: string
  name: string
  platform: string
  lastSeenAt: string | null
  isCurrent: boolean
}

export async function listDevices(
  pool: Pool,
  userId: string,
  currentDeviceId: string,
): Promise<DeviceInfo[]> {
  const { rows } = await pool.query<{
    id: string
    name: string
    platform: string
    last_seen_at: string | null
  }>(
    `SELECT id, name, platform, last_seen_at FROM device
     WHERE user_id = $1 AND revoked_at IS NULL
     ORDER BY (id = $2) DESC, last_seen_at DESC NULLS LAST`,
    [userId, currentDeviceId],
  )
  return rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    platform: String(row.platform),
    lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at as string).toISOString() : null,
    isCurrent: String(row.id) === currentDeviceId,
  }))
}

/** Revokes a device and kills its sessions. Returns false if it does not exist. */
export async function revokeDevice(pool: Pool, userId: string, deviceId: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE device SET revoked_at = now()
     WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [deviceId, userId],
  )
  if (result.rowCount === 0) return false
  await pool.query('DELETE FROM session WHERE device_id = $1', [deviceId])
  await pool.query('DELETE FROM push_subscription WHERE device_id = $1', [deviceId])
  return true
}

// --- last_seen_at throttling: at most one write per device per minute ---

const LAST_SEEN_THROTTLE_MS = 60_000
const lastSeenWrites = new Map<string, number>()

export function maybeTouchDevice(pool: Pool, deviceId: string): void {
  const now = Date.now()
  const last = lastSeenWrites.get(deviceId) ?? 0
  if (now - last < LAST_SEEN_THROTTLE_MS) return
  lastSeenWrites.set(deviceId, now)
  pool.query('UPDATE device SET last_seen_at = now() WHERE id = $1', [deviceId]).catch(() => {})
}
