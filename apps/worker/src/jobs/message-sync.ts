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
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ImapFlow } from 'imapflow'
import type { MailboxLockObject } from 'imapflow'
import { simpleParser, type ParsedMail } from 'mailparser'
import type { Pool } from '@fma/db'
import { encryptField, deriveHmacKey, hmacValue } from '@fma/crypto'
import { loadAccountContext, type AccountContext } from '../accounts'
import { log } from '../log'
import { mailTestMode } from '../ports'

const MESSAGE_SYNC_LIMIT = 200
const MAX_RAW_MESSAGE_BYTES = 20 * 1024 * 1024 // skip bodies above 20 MB
const MAX_TEXT_PLAIN_BYTES = 100 * 1024

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
    from?: { value?: { address?: string; name?: string }[] }
    to?: { value?: { address?: string; name?: string }[] }
    cc?: { value?: { address?: string; name?: string }[] }
    date?: Date | string | false
  }
  bodyStructure?: { childNodes?: unknown[] } | false
  size?: number
}

function mailDataDir(): string {
  return process.env.MAIL_DATA_DIR ?? '/app/mail-data'
}

function aad(kind: string, messageId: string): string {
  return `message.${kind}:${messageId}`
}

/** Deterministic fallback id when the server/message has no Message-ID. */
function fallbackMessageId(date: Date | null, size: number, subjectHmac: string): string {
  const hash = createHash('sha256')
    .update(`${date?.getTime() ?? 0}|${size}|${subjectHmac}`)
    .digest('hex')
  return `<${hash}@fma.local>`
}

function personList(value: unknown): { name: string; address: string }[] {
  const list = (value as { value?: { address?: string; name?: string }[] } | undefined)?.value ?? []
  return list
    .filter((entry) => entry.address)
    .map((entry) => ({ name: entry.name ?? '', address: entry.address! }))
}

function normalizeReferences(value: string | string[] | undefined): string[] {
  if (!value) return []
  const raw = Array.isArray(value) ? value : value.split(/\s+/)
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

/** Extracts a plain-text preview/full text from the parsed raw mail. */
async function extractText(raw: Buffer): Promise<string> {
  try {
    const parsed: ParsedMail = await simpleParser(raw)
    const text = (parsed.text ?? '').trim()
    return text.slice(0, MAX_TEXT_PLAIN_BYTES)
  } catch {
    return ''
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
    // initial sync: the newest MESSAGE_SYNC_LIMIT messages.
    const { rows: maxRows } = await pool.query<{ max_uid: string | null }>(
      `SELECT max(uid)::text AS max_uid FROM message_location
       WHERE folder_id = $1 AND uidvalidity = $2`,
      [folderId, serverUidvalidity.toString()],
    )
    const highestSynced = maxRows[0]?.max_uid ? Number(maxRows[0].max_uid) : 0
    let targetUids: number[]
    if (highestSynced > 0) {
      targetUids = allUids.filter((uid) => uid > highestSynced)
    } else {
      targetUids = allUids.slice(-MESSAGE_SYNC_LIMIT)
    }

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
                sent_at, received_at, size_bytes, has_attachments)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), $11, $12)`,
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
                  JSON.stringify({ to: personList(envelope.to), cc: personList(envelope.cc) }),
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
    lock?.release()
    client.close()
  }
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

  // Orphans: messages of this account without any remaining location (a
  // message may still live in another folder). message_body rows cascade;
  // storage refs are read first so the files can be removed afterwards.
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

  const root = path.resolve(mailDataDir())
  for (const orphan of orphans) {
    if (!orphan.storage_ref) continue
    // storage_ref = <account>/<message>/raw.eml.enc: remove the message dir.
    const dir = path.resolve(root, path.dirname(orphan.storage_ref))
    if (!dir.startsWith(root + path.sep)) continue // never leave the volume
    await rm(dir, { recursive: true, force: true })
  }
  log.info(
    { accountId, folderId, locationsRemoved: removed.length, messagesRemoved: orphans.length },
    'expunged messages reconciled',
  )
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

  const text = await extractText(raw)
  await pool.query(`UPDATE message SET snippet_enc = $2 WHERE id = $1`, [
    messageId,
    Buffer.from(encryptField(ctx.dek, text.slice(0, 200), aad('snippet', messageId)), 'utf8'),
  ])
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
