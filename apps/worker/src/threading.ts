/**
 * Thread assignment (roadmap 2.5): gives every synced message of an account
 * a thread_id, using the pure grouping rules of @fma/shared (simplified
 * JWZ: References/In-Reply-To, subject fallback within a time window).
 *
 * Incremental: each unthreaded message is grouped together with its
 * candidate neighbours from the database (messages it references, messages
 * referencing it or sharing a referenced id, and messages with the same
 * subject hash inside the window). All threads in the message's group are
 * merged into one - this is how a parent arriving after its children joins
 * their threads. Messages are processed oldest first, so most parents are
 * already threaded when their replies come in.
 *
 * Subjects are encrypted; the fallback uses `message.subject_hash`, an HMAC
 * of the normalized subject with a key derived from the account DEK.
 * Messages with outdated metadata (migration 0007) wait for the backfill,
 * since their References may still be missing.
 *
 * One transaction per run with a per-account advisory lock: concurrent
 * message_sync jobs of the same account must not create duplicate threads.
 */
import { randomUUID } from 'node:crypto'
import type { Pool } from '@fma/db'
import { decryptField, deriveHmacKey, hmacValue, messageFieldAad as aad } from '@fma/crypto'
import {
  SUBJECT_THREAD_WINDOW_MS,
  groupThreads,
  hasReplyPrefix,
  threadLinks,
  threadSubjectKey,
  type ThreadingMessage,
} from '@fma/shared'
import type { AccountContext } from './accounts'

/** Unthreaded messages handled per run (the rest follows next run). */
const THREAD_ASSIGN_LIMIT = 500
/** Upper bound of neighbours considered per message. */
const MAX_CANDIDATES = 200

const SORT_AT = 'coalesce(sent_at, received_at, created_at)'

interface MessageRow {
  id: string
  message_id_header: string
  in_reply_to: string | null
  references: string[]
  subject_enc: Buffer
  subject_hash: Buffer | null
  thread_id: string | null
  sort_at: Date
}

/** HMAC key for subject hashes (derived from the DEK, never stored). */
function subjectHashKey(dek: Buffer): Buffer {
  return deriveHmacKey(dek, 'thread-subject')
}

function decryptSubject(dek: Buffer, row: MessageRow): string {
  try {
    return decryptField(dek, row.subject_enc.toString('utf8'), aad('subject', row.id))
  } catch {
    return ''
  }
}

function toThreadingMessage(
  row: MessageRow,
  subjectKey: string | null,
  isReply: boolean,
): ThreadingMessage {
  return {
    id: row.id,
    messageId: row.message_id_header,
    inReplyTo: row.in_reply_to,
    references: row.references,
    subjectKey,
    isReply,
    date: row.sort_at.getTime(),
  }
}

/**
 * Assigns threads to unthreaded messages of an account (bounded per run).
 * Returns the number of messages threaded.
 */
export async function assignThreads(
  pool: Pool,
  ctx: AccountContext,
  accountId: string,
  minMetadataVersion: number,
): Promise<number> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('thread:' || $1, 0))", [
      accountId,
    ])

    const { rows: pending } = await client.query<MessageRow>(
      `SELECT id::text, message_id_header, in_reply_to, "references", subject_enc, subject_hash,
              thread_id::text, ${SORT_AT} AS sort_at
       FROM message
       WHERE account_id = $1 AND thread_id IS NULL AND metadata_version >= $2
       ORDER BY ${SORT_AT}, id
       LIMIT $3`,
      [accountId, minMetadataVersion, THREAD_ASSIGN_LIMIT],
    )
    const hmacKey = subjectHashKey(ctx.dek)

    for (const message of pending) {
      const subject = decryptSubject(ctx.dek, message)
      const key = threadSubjectKey(subject)
      const subjectHash = key ? Buffer.from(hmacValue(hmacKey, key), 'hex') : null
      const links = threadLinks({
        messageId: message.message_id_header,
        inReplyTo: message.in_reply_to,
        references: message.references,
      })
      const ids = [...links, message.message_id_header]

      // Threaded neighbours only: unthreaded ones find this message later.
      const { rows: candidates } = await client.query<MessageRow>(
        `SELECT id::text, message_id_header, in_reply_to, "references", subject_enc,
                subject_hash, thread_id::text, ${SORT_AT} AS sort_at
         FROM message
         WHERE account_id = $1 AND thread_id IS NOT NULL AND id <> $2
           AND (message_id_header = ANY($3::text[])
                OR "references" && $4::text[]
                OR in_reply_to = ANY($4::text[])
                OR (subject_hash = $5::bytea
                    AND ${SORT_AT} BETWEEN $6::timestamptz - make_interval(secs => $7)
                                       AND $6::timestamptz + make_interval(secs => $7)))
         LIMIT $8`,
        [
          accountId,
          message.id,
          links,
          ids,
          subjectHash,
          message.sort_at,
          SUBJECT_THREAD_WINDOW_MS / 1000,
          MAX_CANDIDATES,
        ],
      )

      // Subject keys are compared as hashes; only same-subject neighbours
      // need theirs (and their reply prefix) for the fallback.
      const hashHex = subjectHash?.toString('hex') ?? null
      const group = groupThreads([
        toThreadingMessage(message, hashHex, hasReplyPrefix(subject)),
        ...candidates.map((row) => {
          const same = hashHex !== null && row.subject_hash?.toString('hex') === hashHex
          return toThreadingMessage(
            row,
            same ? hashHex : null,
            same && hasReplyPrefix(decryptSubject(ctx.dek, row)),
          )
        }),
      ]).find((ids) => ids.includes(message.id))!
      const members = new Set(group)
      const threadIds = [
        ...new Set(candidates.filter((row) => members.has(row.id)).map((row) => row.thread_id!)),
      ]

      let threadId: string
      if (threadIds.length === 0) {
        threadId = randomUUID()
        await client.query('INSERT INTO thread (id, account_id) VALUES ($1, $2)', [
          threadId,
          accountId,
        ])
      } else {
        // Merge into the oldest thread.
        const { rows } = await client.query<{ id: string }>(
          'SELECT id::text FROM thread WHERE id = ANY($1::uuid[]) ORDER BY created_at, id LIMIT 1',
          [threadIds],
        )
        threadId = rows[0]!.id
        const merged = threadIds.filter((id) => id !== threadId)
        if (merged.length > 0) {
          await client.query(
            'UPDATE message SET thread_id = $1 WHERE account_id = $2 AND thread_id = ANY($3::uuid[])',
            [threadId, accountId, merged],
          )
          await client.query('DELETE FROM thread WHERE id = ANY($1::uuid[])', [merged])
        }
      }

      await client.query('UPDATE message SET thread_id = $2, subject_hash = $3 WHERE id = $1', [
        message.id,
        threadId,
        subjectHash,
      ])
      await client.query(
        `UPDATE thread SET last_message_at = (
           SELECT max(${SORT_AT}) FROM message WHERE thread_id = $1
         ) WHERE id = $1`,
        [threadId],
      )
    }

    await client.query('COMMIT')
    return pending.length
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/** Deletes threads of an account that no longer contain any message. */
export async function removeEmptyThreads(pool: Pool, accountId: string): Promise<void> {
  await pool.query(
    `DELETE FROM thread t
     WHERE t.account_id = $1
       AND NOT EXISTS (SELECT 1 FROM message m WHERE m.thread_id = t.id)`,
    [accountId],
  )
}
