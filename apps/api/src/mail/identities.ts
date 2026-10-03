/**
 * Sender identities of an account (roadmap 2.6): listed for the compose
 * form (From select, own addresses for "reply all", signature). Only the
 * signature is editable for now; adding/removing identities follows in 3.6.
 *
 * Ownership is checked via mail_account.user_id; foreign or unknown ids
 * answer 404.
 */
import type { FastifyInstance } from 'fastify'
import { MAX_SIGNATURE_LENGTH, type ComposeIdentity, type IdentityListResponse } from '@fma/shared'
import { requireAuth } from '../auth/routes'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface IdentityRow {
  id: string
  name: string
  email_address: string
  signature: string | null
  is_default: boolean
}

const IDENTITY_COLUMNS = `i.id, i.name, i.email_address, i.signature,
  lower(i.email_address) = lower(a.email_address) AS is_default`

function toIdentity(row: IdentityRow): ComposeIdentity {
  return {
    id: row.id,
    name: row.name,
    emailAddress: row.email_address,
    signature: row.signature,
    isDefault: row.is_default,
  }
}

export async function identityRoutes(app: FastifyInstance): Promise<void> {
  const pool = app.authPool

  app.get<{ Params: { id: string } }>(
    '/api/accounts/:id/identities',
    { preHandler: requireAuth },
    async (request, reply) => {
      const accountId = request.params.id
      if (!UUID_RE.test(accountId)) {
        await reply.code(404).send({ message: 'Konto nicht gefunden.' })
        return
      }
      const account = await pool.query(
        'SELECT 1 FROM mail_account WHERE id = $1 AND user_id = $2',
        [accountId, request.auth!.userId],
      )
      if (account.rowCount === 0) {
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

  app.patch<{ Params: { id: string }; Body: unknown }>(
    '/api/identities/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      const identityId = request.params.id
      const input = (request.body ?? {}) as { signature?: unknown }
      if (
        !('signature' in input) ||
        (input.signature !== null && typeof input.signature !== 'string')
      ) {
        await reply.code(400).send({ message: 'Ungültige Signatur.' })
        return
      }
      const signature =
        typeof input.signature === 'string'
          ? input.signature.replace(/\r\n?/g, '\n').replace(/\s+$/, '')
          : null
      if (signature !== null && signature.length > MAX_SIGNATURE_LENGTH) {
        await reply.code(400).send({ message: 'Die Signatur ist zu lang.' })
        return
      }
      if (!UUID_RE.test(identityId)) {
        await reply.code(404).send({ message: 'Identität nicht gefunden.' })
        return
      }
      const { rows } = await pool.query<IdentityRow>(
        `UPDATE identity i SET signature = $3
         FROM mail_account a
         WHERE i.id = $1 AND a.id = i.account_id AND a.user_id = $2
         RETURNING ${IDENTITY_COLUMNS}`,
        [identityId, request.auth!.userId, signature || null],
      )
      const row = rows[0]
      if (!row) {
        await reply.code(404).send({ message: 'Identität nicht gefunden.' })
        return
      }
      await reply.send({ identity: toIdentity(row) })
    },
  )
}
