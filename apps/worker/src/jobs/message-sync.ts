/**
 * message_sync job (roadmap 2.2 step 2): fetches messages of one folder
 * (newest first, bounded), stores metadata in the database (human-readable
 * fields encrypted with the account DEK), downloads the raw RFC-822 source
 * encrypted into the mail-data volume, and keeps message_location rows
 * (per-folder UIDs and flags) in sync.
 *
 * Bounded initial fetch: the newest MESSAGE_SYNC_LIMIT messages per folder;
 * incremental runs fetch only UIDs above the highest synced one.
 *
 * Reconciliation of already known messages: every run lists UID+FLAGS of
 * the whole folder (cheap, no headers), updates changed flags and removes
 * locations whose UID vanished on the server (expunged/moved). A message
 * without any remaining location is deleted together with its encrypted
 * body file.
 *
 * Optimistic message actions (roadmap 2.4, ./message-action): placeholder
 * locations of moved messages (uid < 0) are replaced once the moved
 * message is fetched here, and dropped when no write-back is pending.
 *
 * Threading (roadmap 2.5, ../threading): after each run, unthreaded
 * messages of the account get a thread_id.
 *
 * Metadata backfill (migration 0007): messages stored with an outdated
 * metadata_version get their addresses, Reply-To and threading headers
 * re-derived in bounded batches - from the encrypted raw mail in the
 * mail-data volume when present, else from IMAP (envelope + References).
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ImapFlow } from 'imapflow'
import type { MailboxLockObject } from 'imapflow'
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser'
import type { Pool } from '@fma/db'
import {
  decryptField,
  encryptField,
  deriveHmacKey,
  hmacValue,
  messageFieldAad as aad,
} from '@fma/crypto'
import { loadAccountContext, type AccountContext } from '../accounts'
import { closeOnJobAbort } from '../job-context'
import { log } from '../log'
import { mailTestMode } from '../ports'
import { assignThreads, removeEmptyThreads } from '../threading'

const MESSAGE_SYNC_LIMIT = 200
const MAX_RAW_MESSAGE_BYTES = 20 * 1024 * 1024 // skip bodies above 20 MB
const MAX_TEXT_PLAIN_BYTES = 100 * 1024
/** Newest References kept per message (threading needs only a few). */
const MAX_REFERENCES = 100

/**
 * Version of the metadata a message row was stored with (migration 0007).
 * Bump it whenever the sync starts deriving more or different metadata;
 * backfillMetadata() re-derives outdated rows.
 * - 1: From/To/Cc stored as empty lists, no Reply-To/References (bug)
 * - 2: addresses, Reply-To (when it differs from From), References
 */
export const MESSAGE_METADATA_VERSION = 2
/** Outdated messages re-derived per message_sync run and folder. */
const METADATA_BACKFILL_LIMIT = 200

type Person = { name: string; address: string }

/** Metadata re-derived by the backfill. */
interface DerivedMetadata {
  from: Person[]
  to: Person[]
  cc: Person[]
  replyTo: Person[]
  inReplyTo: string | null
  references: string[]
}

interface EnvelopeAddress {
  address?: string
  name?: string
}

interface FetchMessage {
  uid: number
  seq: number
  modseq?: bigint
  flags: Set<string>
  envelope?: {
    messageId?: string
    inReplyTo?: string
    references?: string | string[]
    subject?: string
    from?: EnvelopeAddress[]
    to?: EnvelopeAddress[]
    cc?: EnvelopeAddress[]
    replyTo?: EnvelopeAddress[]
    date?: Date | string | false
  }
  bodyStructure?: { childNodes?: unknown[] } | false
  size?: number
}

function mailDataDir(): string {
  return process.env.MAIL_DATA_DIR ?? '/app/mail-data'
}

/** Deterministic fallback id when the server/message has no Message-ID. */
function fallbackMessageId(date: Date | null, size: number, subjectHmac: string): string {
  const hash = createHash('sha256')
    .update(`${date?.getTime() ?? 0}|${size}|${subjectHmac}`)
    .digest('hex')
  return `<${hash}@fma.local>`
}

/**
 * imapflow returns envelope addresses as arrays; `{ value: [...] }`
 * (mailparser shape) is accepted as well.
 */
function personList(value: unknown): Person[] {
  const list: EnvelopeAddress[] = Array.isArray(value)
    ? (value as EnvelopeAddress[])
    : ((value as { value?: EnvelopeAddress[] } | undefined)?.value ?? [])
  return list
    .filter((entry) => entry.address)
    .map((entry) => ({ name: entry.name ?? '', address: entry.address! }))
}

/**
 * Reply-To only when it differs from From: IMAP servers fill the envelope's
 * reply-to with From when the header is missing (RFC 3501 7.4.2).
 */
function replyToList(envelope: NonNullable<FetchMessage['envelope']>): Person[] {
  return distinctReplyTo(personList(envelope.replyTo), personList(envelope.from))
}

function distinctReplyTo(replyTo: Person[], fromList: Person[]): Person[] {
  const from = new Set(fromList.map((p) => p.address.toLowerCase()))
  if (replyTo.length === 0 || replyTo.every((p) => from.has(p.address.toLowerCase()))) return []
  return replyTo
}

/** Address list of a parsed (mailparser) header, groups flattened. */
function parsedPeople(value: AddressObject | AddressObject[] | undefined): Person[] {
  const objects = value ? (Array.isArray(value) ? value : [value]) : []
  const people: Person[] = []
  for (const object of objects) {
    for (const entry of object.value ?? []) {
      for (const member of entry.group ?? [entry]) {
        if (member.address) people.push({ name: member.name ?? '', address: member.address })
      }
    }
  }
  return people
}

/** Message-IDs (`<...>`) of a raw References header value. */
function referencesFromHeaderBlock(headers: Buffer | undefined): string[] {
  if (!headers) return []
  const unfolded = headers.toString('latin1').replace(/\r?\n[ \t]+/g, ' ')
  const match = /^references:[ \t]*(.*)$/im.exec(unfolded)
  if (!match?.[1]) return []
  return (match[1].match(/<[^<>\s]+>/g) ?? []).slice(-MAX_REFERENCES)
}

function normalizeReferences(value: string | string[] | undefined): string[] {
  if (!value) return []
  const raw = (Array.isArray(value) ? value.join(' ') : value).split(/\s+/)
  return raw.map((ref) => ref.trim()).filter((ref) => ref.startsWith('<'))
}

async function streamToBuffer(
  stream: NodeJS.ReadableStream,
  maxBytes: number,
): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    total += buf.length
    if (total > maxBytes) return null // over limit: skip body
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

/**
 * Extracts the plain text (preview/full text) and the References header
 * from the raw mail (the IMAP envelope does not carry References).
 */
async function parseRaw(raw: Buffer): Promise<{ text: string; references: string[] }> {
  try {
    const parsed: ParsedMail = await simpleParser(raw)
    const text = (parsed.text ?? '').trim()
    return {
      text: text.slice(0, MAX_TEXT_PLAIN_BYTES),
      references: normalizeReferences(parsed.references).slice(-MAX_REFERENCES),
    }
  } catch {
    return { text: '', references: [] }
  }
}

export async function runMessageSync(
  pool: Pool,
  accountId: string,
  folderId: string,
  context?: AccountContext,
): Promise<void> {
  const ctx = context ?? (await loadAccountContext(pool, accountId, process.env.MASTER_KEY ?? ''))

  const folderRows = await pool.query<{ id: string; path: string; uidvalidity: string | null }>(
    'SELECT id, path, uidvalidity FROM folder WHERE id = $1 AND account_id = $2',
    [folderId, accountId],
  )
  const folder = folderRows.rows[0]
  if (!folder) throw new Error(`folder ${folderId} not found for account ${accountId}`)

  const client = new ImapFlow({
    host: ctx.imap.host,
    port: ctx.imap.port,
    secure: ctx.imap.secure,
    auth: { user: ctx.imap.user, pass: ctx.imap.password },
    logger: false,
    greetingTimeout: 15_000,
    tls: mailTestMode() ? { rejectUnauthorized: false } : undefined,
    ...(mailTestMode() ? { doSTARTTLS: false as const } : {}),
  })

  const unregister = closeOnJobAbort(() => client.close())
  let lock: MailboxLockObject | null = null
  try {
    await client.connect()
    lock = await client.getMailboxLock(folder.path)
    const selected = (
      client as unknown as {
        mailbox?: { uidValidity?: bigint | string; uidNext?: number; exists?: number }
      }
    ).mailbox
    if (!selected) throw new Error('mailbox could not be selected')

    const serverUidvalidity = BigInt(selected.uidValidity ?? 0)
    const dbUidvalidity = folder.uidvalidity ? BigInt(folder.uidvalidity) : null

    // UIDVALIDITY changed (or first sync): old locations for this folder are
    // meaningless and get discarded; messages are re-fetched as new UIDs.
    if (dbUidvalidity !== null && dbUidvalidity !== serverUidvalidity) {
      await pool.query('DELETE FROM message_location WHERE folder_id = $1', [folderId])
    }

    // List all UIDs (cheap, headers only), then fetch by EXPLICIT uid list:
    // range strings like "22:*" are unreliable across servers (GreenMail
    // omits the highest message even though RFC 3501 mandates including it,
    // and Dovecot rejects FETCH 1:* on an EMPTY mailbox with BAD
    // "Invalid messageset").
    const allUids: number[] = []
    const serverFlags = new Map<number, string[]>()
    if ((selected.exists ?? 0) > 0) {
      for await (const msg of client.fetch('1:*', { uid: true, flags: true })) {
        allUids.push(msg.uid)
        serverFlags.set(msg.uid, [...(msg.flags ?? [])])
      }
    }

    await reconcileKnownMessages(pool, accountId, folderId, serverUidvalidity, serverFlags)

    // Incremental: UIDs above the highest synced one of THIS uidvalidity;
    // initial sync: the newest MESSAGE_SYNC_LIMIT messages. Unknown UIDs
    // inside the newest window are fetched as well: this self-heals local
    // optimistic changes the server never applied (e.g. a message_action
    // write-back that failed for good restores the message here).
    const { rows: knownRows } = await pool.query<{ uid: string }>(
      `SELECT uid::text AS uid FROM message_location
       WHERE folder_id = $1 AND uidvalidity = $2`,
      [folderId, serverUidvalidity.toString()],
    )
    const knownUids = new Set(knownRows.map((row) => Number(row.uid)))
    let highestSynced = 0
    for (const uid of knownUids) if (uid > highestSynced) highestSynced = uid
    const windowStart = allUids.length - MESSAGE_SYNC_LIMIT
    const targetUids = allUids.filter(
      (uid, index) =>
        !knownUids.has(uid) && (index >= windowStart || (highestSynced > 0 && uid > highestSynced)),
    )

    if (targetUids.length > 0) {
      const hmacKey = deriveHmacKey(ctx.dek, 'thread')
      const seenMessageIds = new Map<string, string>() // message_id_header -> message row id (per run)

      // Phase 1: collect metadata. The fetch must be fully consumed before
      // any other command (download) runs - IMAP pipelines one command at a
      // time, calling download() inside the loop would deadlock.
      //
      // Sequence-number workaround: GreenMail's UID FETCH mishandles explicit
      // uid sets (returns nothing), so we fetch by sequence number and map
      // results back to uids by position. Sequence numbers of existing
      // messages are stable while new messages only append.
      const targetSet = new Set(targetUids)
      const seqs: number[] = []
      const uidBySeq = new Map<number, number>()
      allUids.forEach((uid, index) => {
        if (targetSet.has(uid)) {
          const seq = index + 1
          seqs.push(seq)
          uidBySeq.set(seq, uid)
        }
      })

      const fetched: FetchMessage[] = []
      let position = 0
      for await (const msg of client.fetch(seqs, {
        flags: true,
        size: true,
        envelope: true,
        bodyStructure: true,
      })) {
        // Map back via the sequence number the server echoes (fallback:
        // request order). Positions start at 1 while incremental runs fetch
        // e.g. only seq 3, so the position itself is NOT a sequence number.
        const seq = (msg as { seq?: number }).seq ?? seqs[position]
        position += 1
        const uid = seq !== undefined ? uidBySeq.get(seq) : undefined
        if (seq === undefined || uid === undefined) continue
        fetched.push({ ...(msg as unknown as FetchMessage), uid, seq })
      }

      // Phase 2: process messages one by one.
      for (const message of fetched) {
        // Sequence number of this message on the server (for downloads).
        const seq = message.seq
        const envelope = message.envelope ?? {}
        const subject = envelope.subject ?? ''
        const subjectHmac = hmacValue(hmacKey, subject)
        const messageIdHeader =
          envelope.messageId ||
          fallbackMessageId(
            envelope.date ? new Date(envelope.date) : null,
            message.size ?? 0,
            subjectHmac,
          )

        // Deduplicate within the account by message_id_header.
        let dbMessageId = seenMessageIds.get(messageIdHeader)
        if (!dbMessageId) {
          const existing = await pool.query<{ id: string }>(
            'SELECT id FROM message WHERE account_id = $1 AND message_id_header = $2',
            [accountId, messageIdHeader],
          )
          dbMessageId = existing.rows[0]?.id
        }
        if (!dbMessageId) {
          dbMessageId = randomUUID()
          await pool.query(
            `INSERT INTO message
               (id, account_id, message_id_header, in_reply_to, "references",
                subject_enc, from_enc, recipients_enc, snippet_enc,
                sent_at, received_at, size_bytes, has_attachments, metadata_version)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), $11, $12, $13)`,
            [
              dbMessageId,
              accountId,
              messageIdHeader,
              envelope.inReplyTo ?? null,
              normalizeReferences(envelope.references),
              Buffer.from(encryptField(ctx.dek, subject, aad('subject', dbMessageId)), 'utf8'),
              Buffer.from(
                encryptField(
                  ctx.dek,
                  JSON.stringify(personList(envelope.from)),
                  aad('from', dbMessageId),
                ),
                'utf8',
              ),
              Buffer.from(
                encryptField(
                  ctx.dek,
                  JSON.stringify({
                    to: personList(envelope.to),
                    cc: personList(envelope.cc),
                    replyTo: replyToList(envelope),
                  }),
                  aad('recipients', dbMessageId),
                ),
                'utf8',
              ),
              Buffer.from(encryptField(ctx.dek, '', aad('snippet', dbMessageId)), 'utf8'), // filled below
              envelope.date ? new Date(envelope.date) : null,
              message.size ?? 0,
              Boolean(
                message.bodyStructure &&
                typeof message.bodyStructure === 'object' &&
                (message.bodyStructure as { childNodes?: unknown[] }).childNodes?.length,
              ),
              MESSAGE_METADATA_VERSION,
            ],
          )
        }

        // Location: (folder, uidvalidity, uid) unique, flags live here.
        await pool.query(
          `INSERT INTO message_location (message_id, folder_id, uidvalidity, uid, flags, modseq)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (folder_id, uidvalidity, uid) DO UPDATE SET
             message_id = EXCLUDED.message_id,
             flags = EXCLUDED.flags,
             modseq = EXCLUDED.modseq`,
          [
            dbMessageId,
            folderId,
            serverUidvalidity.toString(),
            message.uid,
            [...(message.flags ?? [])],
            message.modseq != null ? BigInt(message.modseq) : null,
          ],
        )
        // The message arrived here through an optimistic move (message
        // actions): its placeholder location is replaced by the real one.
        await pool.query(
          `DELETE FROM message_location
           WHERE folder_id = $1 AND message_id = $2 AND uid < 0`,
          [folderId, dbMessageId],
        )

        // Raw body + plaintext: for new messages and for messages whose body
        // fetch was interrupted earlier.
        if (!seenMessageIds.has(messageIdHeader)) {
          seenMessageIds.set(messageIdHeader, dbMessageId)
        }
        const bodyRow = await pool.query('SELECT 1 FROM message_body WHERE message_id = $1', [
          dbMessageId,
        ])
        if (bodyRow.rowCount === 0) {
          await downloadBody(pool, ctx, client, accountId, dbMessageId, seq)
        }
      }

      // Backfill: bodies for older messages in this folder that were stored
      // without one (e.g. interrupted syncs) - keyed by uid, downloaded by
      // sequence number.
      const missingBodies = await pool.query<{ id: string; uid: string }>(
        `SELECT ml.message_id::text AS id, ml.uid::text AS uid
         FROM message_location ml
         LEFT JOIN message_body mb ON mb.message_id = ml.message_id
         WHERE ml.folder_id = $1 AND mb.message_id IS NULL`,
        [folderId],
      )
      for (const row of missingBodies.rows) {
        const seq = allUids.indexOf(Number(row.uid)) + 1
        if (seq > 0) {
          await downloadBody(pool, ctx, client, accountId, row.id, seq)
        }
      }
    }

    try {
      await backfillMetadata(pool, ctx, client, accountId, folderId, serverUidvalidity, allUids)
    } catch (err) {
      // Best effort: the regular sync result stays; the next run retries.
      log.warn(
        { accountId, folderId, error: err instanceof Error ? err.name : 'unknown' },
        'metadata backfill failed',
      )
    }

    await dropStalePlaceholders(pool, accountId, folderId)

    // Update folder sync state.
    await pool.query(
      `UPDATE folder SET uidvalidity = $2, uidnext = $3, last_synced_at = now(),
         unread_count = (
           SELECT count(*)::int FROM message_location ml
           WHERE ml.folder_id = $1 AND NOT ('\\Seen' = ANY(ml.flags))
         )
       WHERE id = $1`,
      [folderId, serverUidvalidity.toString(), String(selected.uidNext ?? 0)],
    )
  } finally {
    unregister()
    lock?.release()
    client.close()
  }

  // Threading (roadmap 2.5) for new and backfilled messages of the account;
  // best effort, unthreaded messages are picked up by the next run.
  try {
    await assignThreads(pool, ctx, accountId, MESSAGE_METADATA_VERSION)
  } catch (err) {
    log.warn(
      { accountId, folderId, error: err instanceof Error ? err.name : 'unknown' },
      'thread assignment failed',
    )
  }
}

/**
 * Removes placeholder locations (optimistic moves, uid < 0) of a folder that
 * no pending message_action job will resolve anymore: the move either
 * failed for good or the moved message was not found in this sync. Messages
 * left without any location are removed; the source folder's sync restores
 * them if they are still on the server.
 */
async function dropStalePlaceholders(
  pool: Pool,
  accountId: string,
  folderId: string,
): Promise<void> {
  const { rows } = await pool.query<{ message_id: string }>(
    `DELETE FROM message_location
     WHERE folder_id = $1 AND uid < 0
       AND NOT EXISTS (
         SELECT 1 FROM job
         WHERE type = 'message_action' AND account_id = $2 AND state IN ('queued', 'running')
       )
     RETURNING message_id::text`,
    [folderId, accountId],
  )
  if (rows.length === 0) return
  const messagesRemoved = await removeOrphanMessages(
    pool,
    accountId,
    rows.map((row) => row.message_id),
  )
  log.info(
    { accountId, folderId, placeholdersRemoved: rows.length, messagesRemoved },
    'stale move placeholders removed',
  )
}

function sameFlags(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((flag) => set.has(flag))
}

/**
 * Applies server state to already known locations of one folder: updates
 * changed flags, deletes locations whose UID is gone (expunged or moved
 * away) and removes messages that no longer have any location, including
 * their encrypted raw file in the mail-data volume.
 */
async function reconcileKnownMessages(
  pool: Pool,
  accountId: string,
  folderId: string,
  uidvalidity: bigint,
  serverFlags: Map<number, string[]>,
): Promise<void> {
  const { rows: known } = await pool.query<{
    id: string
    uid: string
    flags: string[]
  }>(
    `SELECT id, uid::text AS uid, flags FROM message_location
     WHERE folder_id = $1 AND uidvalidity = $2`,
    [folderId, uidvalidity.toString()],
  )

  const vanished: string[] = []
  for (const row of known) {
    const flags = serverFlags.get(Number(row.uid))
    if (!flags) {
      vanished.push(row.id)
    } else if (!sameFlags(row.flags, flags)) {
      await pool.query('UPDATE message_location SET flags = $2 WHERE id = $1', [row.id, flags])
    }
  }
  if (vanished.length === 0) return

  const { rows: removed } = await pool.query<{ message_id: string }>(
    'DELETE FROM message_location WHERE id = ANY($1::uuid[]) RETURNING message_id::text',
    [vanished],
  )
  const candidates = [...new Set(removed.map((row) => row.message_id))]
  const messagesRemoved = await removeOrphanMessages(pool, accountId, candidates)
  log.info(
    { accountId, folderId, locationsRemoved: removed.length, messagesRemoved },
    'expunged messages reconciled',
  )
}

/**
 * Deletes the given messages of an account if they no longer have any
 * location (a message may still live in another folder), including their
 * encrypted raw file in the mail-data volume. Returns the number removed.
 */
export async function removeOrphanMessages(
  pool: Pool,
  accountId: string,
  candidates: string[],
): Promise<number> {
  if (candidates.length === 0) return 0
  // message_body rows cascade; storage refs are read first so the files can
  // be removed afterwards.
  const { rows: orphans } = await pool.query<{ id: string; storage_ref: string | null }>(
    `WITH orphan AS (
       SELECT m.id FROM message m
       WHERE m.id = ANY($1::uuid[]) AND m.account_id = $2
         AND NOT EXISTS (SELECT 1 FROM message_location ml WHERE ml.message_id = m.id)
     ), refs AS (
       SELECT mb.message_id, mb.storage_ref FROM message_body mb
       JOIN orphan o ON o.id = mb.message_id
     )
     DELETE FROM message m USING orphan o
     WHERE m.id = o.id
     RETURNING m.id::text AS id,
       (SELECT storage_ref FROM refs WHERE refs.message_id = m.id) AS storage_ref`,
    [candidates, accountId],
  )

  if (orphans.length > 0) await removeEmptyThreads(pool, accountId)

  const root = path.resolve(mailDataDir())
  for (const orphan of orphans) {
    if (!orphan.storage_ref) continue
    // storage_ref = <account>/<message>/raw.eml.enc: remove the message dir.
    const dir = path.resolve(root, path.dirname(orphan.storage_ref))
    if (!dir.startsWith(root + path.sep)) continue // never leave the volume
    await rm(dir, { recursive: true, force: true })
  }
  return orphans.length
}

/**
 * Downloads the raw RFC-822 source of one message (by sequence number),
 * encrypts it with the account DEK and stores it in the mail-data volume;
 * also stores the plain-text version (encrypted) in the database.
 */
async function downloadBody(
  pool: Pool,
  ctx: AccountContext,
  client: ImapFlow,
  accountId: string,
  messageId: string,
  seq: number,
): Promise<void> {
  const download = await client.download(String(seq), undefined)
  if (!('content' in download) || !download.content) {
    log.warn({ accountId, messageId, seq }, 'message download returned no content')
    return
  }
  const raw = await streamToBuffer(download.content, MAX_RAW_MESSAGE_BYTES)
  if (!raw) {
    log.warn({ accountId, messageId, seq }, 'raw message exceeds size limit, body skipped')
    return
  }

  // storage_ref is relative to the MAIL_DATA_DIR root.
  const relativeRef = path.join(accountId, messageId, 'raw.eml.enc')
  const absolutePath = path.join(mailDataDir(), accountId, messageId)
  await mkdir(absolutePath, { recursive: true })
  await writeFile(
    path.join(absolutePath, 'raw.eml.enc'),
    Buffer.from(encryptField(ctx.dek, raw.toString('latin1'), aad('body', messageId)), 'utf8'),
  )

  const { text, references } = await parseRaw(raw)
  await pool.query(
    `UPDATE message SET snippet_enc = $2,
       "references" = CASE WHEN cardinality($3::text[]) > 0 THEN $3::text[] ELSE "references" END
     WHERE id = $1`,
    [
      messageId,
      Buffer.from(encryptField(ctx.dek, text.slice(0, 200), aad('snippet', messageId)), 'utf8'),
      references,
    ],
  )
  await pool.query(
    `INSERT INTO message_body (message_id, storage_ref, text_plain_enc)
     VALUES ($1, $2, $3)
     ON CONFLICT (message_id) DO NOTHING`,
    [
      messageId,
      relativeRef,
      Buffer.from(encryptField(ctx.dek, text, aad('text', messageId)), 'utf8'),
    ],
  )
}

/**
 * Re-derives addresses, Reply-To and threading headers of messages in this
 * folder whose metadata_version is outdated (bounded per run). Prefers the
 * encrypted raw mail in the mail-data volume (no provider round-trip);
 * messages without a usable raw file are fetched from IMAP (envelope +
 * References header). Must run while no other IMAP command is pending.
 */
async function backfillMetadata(
  pool: Pool,
  ctx: AccountContext,
  client: ImapFlow,
  accountId: string,
  folderId: string,
  uidvalidity: bigint,
  allUids: number[],
): Promise<void> {
  const { rows } = await pool.query<{ id: string; uid: string; storage_ref: string | null }>(
    `SELECT DISTINCT ON (m.id) m.id::text AS id, ml.uid::text AS uid, mb.storage_ref
     FROM message m
     JOIN message_location ml ON ml.message_id = m.id
     LEFT JOIN message_body mb ON mb.message_id = m.id
     WHERE ml.folder_id = $1 AND ml.uidvalidity = $2 AND ml.uid > 0
       AND m.account_id = $3 AND m.metadata_version < $4
     ORDER BY m.id
     LIMIT $5`,
    [
      folderId,
      uidvalidity.toString(),
      accountId,
      MESSAGE_METADATA_VERSION,
      METADATA_BACKFILL_LIMIT,
    ],
  )
  if (rows.length === 0) return

  let fromRaw = 0
  const viaImap = new Map<number, string>() // sequence number -> message id
  for (const row of rows) {
    const metadata = row.storage_ref
      ? await metadataFromStoredRaw(ctx, row.id, row.storage_ref)
      : null
    if (metadata) {
      await storeMetadata(pool, ctx, row.id, metadata)
      fromRaw += 1
      continue
    }
    const seq = allUids.indexOf(Number(row.uid)) + 1
    if (seq > 0) viaImap.set(seq, row.id)
  }

  // IMAP fallback, fetched by sequence number (see runMessageSync). The
  // fetch is consumed completely before the database writes.
  const fetched: { messageId: string; metadata: DerivedMetadata }[] = []
  if (viaImap.size > 0) {
    const seqs = [...viaImap.keys()]
    let position = 0
    for await (const msg of client.fetch(seqs, { envelope: true, headers: ['references'] })) {
      const seq = (msg as { seq?: number }).seq ?? seqs[position]
      position += 1
      const messageId = seq !== undefined ? viaImap.get(seq) : undefined
      if (!messageId) continue
      const envelope = (msg.envelope ?? {}) as NonNullable<FetchMessage['envelope']>
      fetched.push({
        messageId,
        metadata: {
          from: personList(envelope.from),
          to: personList(envelope.to),
          cc: personList(envelope.cc),
          replyTo: replyToList(envelope),
          inReplyTo: envelope.inReplyTo || null,
          references: referencesFromHeaderBlock(msg.headers),
        },
      })
    }
  }
  for (const { messageId, metadata } of fetched) {
    await storeMetadata(pool, ctx, messageId, metadata)
  }
  log.info(
    {
      accountId,
      folderId,
      fromRaw,
      fromImap: fetched.length,
      pending: rows.length - fromRaw - fetched.length,
    },
    'message metadata backfilled',
  )
}

/**
 * Parses the header section of the stored raw mail. Returns null when the
 * file is missing or unreadable (caller falls back to IMAP).
 */
async function metadataFromStoredRaw(
  ctx: AccountContext,
  messageId: string,
  storageRef: string,
): Promise<DerivedMetadata | null> {
  const root = path.resolve(mailDataDir())
  const file = path.resolve(root, storageRef)
  if (!file.startsWith(root + path.sep)) return null // never leave the volume
  try {
    const envelope = (await readFile(file)).toString('utf8')
    const raw = Buffer.from(decryptField(ctx.dek, envelope, aad('body', messageId)), 'latin1')
    // Headers only: parsing bodies/attachments is not needed here.
    const crlf = raw.indexOf('\r\n\r\n')
    const lf = raw.indexOf('\n\n')
    const ends = [crlf >= 0 ? crlf + 4 : -1, lf >= 0 ? lf + 2 : -1].filter((i) => i >= 0)
    const end = ends.length > 0 ? Math.min(...ends) : raw.length
    const parsed = await simpleParser(raw.subarray(0, end))
    const from = parsedPeople(parsed.from)
    return {
      from,
      to: parsedPeople(parsed.to),
      cc: parsedPeople(parsed.cc),
      replyTo: distinctReplyTo(parsedPeople(parsed.replyTo), from),
      inReplyTo: parsed.inReplyTo?.trim() || null,
      references: normalizeReferences(parsed.references).slice(-MAX_REFERENCES),
    }
  } catch {
    return null
  }
}

async function storeMetadata(
  pool: Pool,
  ctx: AccountContext,
  messageId: string,
  metadata: DerivedMetadata,
): Promise<void> {
  await pool.query(
    `UPDATE message SET from_enc = $2, recipients_enc = $3, in_reply_to = $4,
       "references" = $5, metadata_version = $6
     WHERE id = $1`,
    [
      messageId,
      Buffer.from(
        encryptField(ctx.dek, JSON.stringify(metadata.from), aad('from', messageId)),
        'utf8',
      ),
      Buffer.from(
        encryptField(
          ctx.dek,
          JSON.stringify({ to: metadata.to, cc: metadata.cc, replyTo: metadata.replyTo }),
          aad('recipients', messageId),
        ),
        'utf8',
      ),
      metadata.inReplyTo,
      metadata.references,
      MESSAGE_METADATA_VERSION,
    ],
  )
}
