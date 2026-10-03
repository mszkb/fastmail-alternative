/**
 * Sender identities of an account (roadmap 2.6, 3.6): listed for the
 * compose form (From select, own addresses for "reply all", signature) and
 * managed in the settings.
 *
 * - `POST /api/accounts/:id/identities` adds an alias (name + address);
 *   addresses are unique per account (case-insensitive, 409).
 * - `PATCH /api/identities/:id` changes name and/or signature, or makes the
 *   identity the default (`isDefault: true`).
 * - `DELETE /api/identities/:id` removes an identity; the default one
 *   cannot be removed (409). Queued outbox messages keep their stored From.
 * - Default: mail_account.default_identity_id, else the identity matching
 *   the account address (IDENTITY_IS_DEFAULT, also used by the outbox).
 *
 * Whether the provider accepts an alias as sender is up to the provider;
 * it is not verified here. Ownership is checked via mail_account.user_id;
 * foreign or unknown ids answer 404.
 */
import type { FastifyInstance } from 'fastify'
import {
  MAX_IDENTITIES_PER_ACCOUNT,
  MAX_IDENTITY_NAME_LENGTH,
  MAX_SIGNATURE_LENGTH,
  type ComposeIdentity,
  type IdentityListResponse,
} from '@fma/shared'
import { requireAuth } from '../auth/routes'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EMAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/
const MAX_EMAIL_LENGTH = 254

/** SQL: is identity `i` the default of account `a`? */
export const IDENTITY_IS_DEFAULT = `(CASE WHEN a.default_identity_id IS NOT NULL
  THEN i.id = a.default_identity_id
  ELSE lower(i.email_address) = lower(a.email_address) END)`

interface IdentityRow {
  id: string
  name: string
  email_address: string
  signature: string | null
  is_default: boolean
}

const IDENTITY_COLUMNS = `i.id, i.name, i.email_address, i.signature,
  ${IDENTITY_IS_DEFAULT} AS is_default`

function toIdentity(row: IdentityRow): ComposeIdentity {
  return {
    id: row.id,
    name: row.name,
    emailAddress: row.email_address,
    signature: row.signature,
    isDefault: row.is_default,
  }
}

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string }

/** Display name: single line, trimmed. */
function parseName(value: unknown): Parsed<string> {
  if (typeof value !== 'string') return { ok: false, message: 'Ungültiger Name.' }
  const name = value.replace(/[\r\n\t]+/g, ' ').trim()
  if (name.length > MAX_IDENTITY_NAME_LENGTH) {
    return { ok: false, message: 'Der Name ist zu lang.' }
  }
  return { ok: true, value: name }
}

/** Signature: CRLF normalized, trailing whitespace removed, empty = null. */
function parseSignature(value: unknown): Parsed<string | null> {
  if (value !== null && typeof value !== 'string') {
    return { ok: false, message: 'Ungültige Signatur.' }
  }
  const signature =
    typeof value === 'string' ? value.replace(/\r\n?/g, '\n').replace(/\s+$/, '') : null
  if (signature !== null && signature.length > MAX_SIGNATURE_LENGTH) {
    return { ok: false, message: 'Die Signatur ist zu lang.' }
  }
  return { ok: true, value: signature || null }
}

function parseEmail(value: unknown): Parsed<string> {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (email.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(email)) {
    return { ok: false, message: 'Ungültige E-Mail-Adresse.' }
  }
  return { ok: true, value: email }
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23505'
}

export async function identityRoutes(app: FastifyInstance): Promise<void> {
  const pool = app.authPool

  async function ownsAccount(accountId: string, userId: string): Promise<boolean> {
    if (!UUID_RE.test(accountId)) return false
    const { rowCount } = await pool.query(
      'SELECT 1 FROM mail_account WHERE id = $1 AND user_id = $2',
      [accountId, userId],
    )
    return rowCount !== 0
  }

  async function loadIdentity(id: string, userId: string): Promise<IdentityRow | null> {
    if (!UUID_RE.test(id)) return null
    const { rows } = await pool.query<IdentityRow>(
      `SELECT ${IDENTITY_COLUMNS}
       FROM identity i JOIN mail_account a ON a.id = i.account_id
       WHERE i.id = $1 AND a.user_id = $2`,
      [id, userId],
    )
    return rows[0] ?? null
  }

  app.get<{ Params: { id: string } }>(
    '/api/accounts/:id/identities',
    { onRequest: requireAuth },
    async (request, reply) => {
      const accountId = request.params.id
      if (!(await ownsAccount(accountId, request.auth!.userId))) {
        await reply.code(404).send({ message: 'Konto nicht gefunden.' })
        return
      }
      const { rows } = await pool.query<IdentityRow>(
        `SELECT ${IDENTITY_COLUMNS}
         FROM identity i JOIN mail_account a ON a.id = i.account_id
         WHERE i.account_id = $1
         ORDER BY is_default DESC, i.email_address, i.id`,
        [accountId],
      )
      const body: IdentityListResponse = { identities: rows.map(toIdentity) }
      await reply.send(body)
    },
  )

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/accounts/:id/identities',
    { onRequest: requireAuth },
    async (request, reply) => {
      const input = (request.body ?? {}) as Record<string, unknown>
      const email = parseEmail(input.emailAddress)
      const name = parseName(input.name ?? '')
      const signature = parseSignature(input.signature ?? null)
      for (const parsed of [email, name, signature]) {
        if (!parsed.ok) {
          await reply.code(400).send({ message: parsed.message })
          return
        }
      }
      const accountId = request.params.id
      if (!(await ownsAccount(accountId, request.auth!.userId))) {
        await reply.code(404).send({ message: 'Konto nicht gefunden.' })
        return
      }
      const count = await pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM identity WHERE account_id = $1',
        [accountId],
      )
      if (count.rows[0]!.n >= MAX_IDENTITIES_PER_ACCOUNT) {
        await reply.code(409).send({ message: 'Zu viele Identitäten für dieses Konto.' })
        return
      }
      try {
        const { rows } = await pool.query<{ id: string }>(
          `INSERT INTO identity (account_id, name, email_address, signature)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [
            accountId,
            (name as { value: string }).value,
            (email as { value: string }).value,
            (signature as { value: string | null }).value,
          ],
        )
        const row = await loadIdentity(rows[0]!.id, request.auth!.userId)
        await reply.code(201).send({ identity: toIdentity(row!) })
      } catch (err) {
        if (!isUniqueViolation(err)) throw err
        await reply
          .code(409)
          .send({ message: 'Diese Adresse ist für das Konto bereits eingetragen.' })
      }
    },
  )

  app.patch<{ Params: { id: string }; Body: unknown }>(
    '/api/identities/:id',
    { onRequest: requireAuth },
    async (request, reply) => {
      const input = (request.body ?? {}) as Record<string, unknown>
      const name = 'name' in input ? parseName(input.name) : null
      const signature = 'signature' in input ? parseSignature(input.signature) : null
      const makeDefault = 'isDefault' in input ? input.isDefault : undefined
      if (!name && !signature && makeDefault === undefined) {
        await reply.code(400).send({ message: 'Keine Änderung angegeben.' })
        return
      }
      if (makeDefault !== undefined && makeDefault !== true) {
        await reply
          .code(400)
          .send({ message: 'Eine andere Identität als Standard wählen, um diese abzulösen.' })
        return
      }
      for (const parsed of [name, signature]) {
        if (parsed && !parsed.ok) {
          await reply.code(400).send({ message: parsed.message })
          return
        }
      }
      const identity = await loadIdentity(request.params.id, request.auth!.userId)
      if (!identity) {
        await reply.code(404).send({ message: 'Identität nicht gefunden.' })
        return
      }

      const sets: string[] = []
      const values: unknown[] = [identity.id]
      if (name?.ok) {
        values.push(name.value)
        sets.push(`name = $${values.length}`)
      }
      if (signature?.ok) {
        values.push(signature.value)
        sets.push(`signature = $${values.length}`)
      }
      if (sets.length > 0) {
        await pool.query(`UPDATE identity SET ${sets.join(', ')} WHERE id = $1`, values)
      }
      if (makeDefault) {
        await pool.query(
          `UPDATE mail_account a SET default_identity_id = i.id
           FROM identity i WHERE i.id = $1 AND a.id = i.account_id`,
          [identity.id],
        )
      }
      const row = await loadIdentity(identity.id, request.auth!.userId)
      await reply.send({ identity: toIdentity(row!) })
    },
  )

  app.delete<{ Params: { id: string } }>(
    '/api/identities/:id',
    { onRequest: requireAuth },
    async (request, reply) => {
      const identity = await loadIdentity(request.params.id, request.auth!.userId)
      if (!identity) {
        await reply.code(404).send({ message: 'Identität nicht gefunden.' })
        return
      }
      if (identity.is_default) {
        await reply
          .code(409)
          .send({ message: 'Die Standard-Identität kann nicht entfernt werden.' })
        return
      }
      await pool.query('DELETE FROM identity WHERE id = $1', [identity.id])
      await reply.code(204).send()
    },
  )
}
