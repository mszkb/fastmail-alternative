/**
 * Tests for the cleanup job (roadmap 5.5): messages without location and
 * their files, uploads, outbox, sessions, push subscriptions, old jobs and
 * unreferenced files in the mail-data volume. The provider part (folder
 * deleted on the server, UIDVALIDITY resync) runs against GreenMail.
 * Requires DATABASE_URL (+ GREENMAIL_HOST for the provider part).
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import pg from 'pg'
import { ImapFlow } from 'imapflow'
import { runMigrations } from '@fma/db/migrate'
import { encryptField, generateDataKey, loadMasterKey, wrapDataKey } from '@fma/crypto'
import {
  cleanupSettings,
  purgeLocationlessMessages,
  removeOrphanFiles,
  runCleanup,
  type CleanupSettings,
} from '../src/jobs/cleanup'
import { runFolderSync } from '../src/jobs/folder-sync'
import { runMessageSync } from '../src/jobs/message-sync'
import { enqueueDueCleanup } from '../src/scheduler'

process.env.MASTER_KEY ??= randomBytes(32).toString('base64')

const databaseUrl = process.env.DATABASE_URL
const greenmailHost = process.env.GREENMAIL_HOST
const greenmailUser = process.env.GREENMAIL_USER ?? ''
const greenmailPassword = process.env.GREENMAIL_PASSWORD ?? ''

const TABLES =
  'session, device, push_subscription, "user", mail_account, identity, folder, job, message, message_location, message_body, thread, outbox_message, attachment_upload'

const HOUR = 60 * 60_000
const SETTINGS: CleanupSettings = {
  jobRetentionMs: 7 * 24 * HOUR,
  failedJobRetentionMs: 30 * 24 * HOUR,
  uploadRetentionMs: 24 * HOUR,
  outboxRetentionMs: 30 * 24 * HOUR,
  orphanFileGraceMs: 24 * HOUR,
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  )
}

/** Writes <dataDir>/<account>/<message>/raw.eml.enc, optionally backdated. */
async function writeRaw(
  dataDir: string,
  accountId: string,
  messageId: string,
  ageMs = 0,
): Promise<string> {
  const dir = path.join(dataDir, accountId, messageId)
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, 'raw.eml.enc')
  await writeFile(file, 'fma.b1.ciphertext')
  if (ageMs > 0) {
    const time = new Date(Date.now() - ageMs)
    await utimes(file, time, time)
    await utimes(dir, time, time)
  }
  return file
}

describe.skipIf(!databaseUrl)('cleanup job', () => {
  let pool: pg.Pool
  let dataDir: string
  let userId: string
  let accountId: string
  let folderId: string

  async function insertMessage(options: { location?: boolean; file?: boolean } = {}) {
    const id = randomUUID()
    await pool.query(
      `INSERT INTO message (id, account_id, message_id_header, subject_enc, from_enc,
         recipients_enc, snippet_enc)
       VALUES ($1, $2, $3, '\\x00', '\\x00', '\\x00', '\\x00')`,
      [id, accountId, `<${id}@example.org>`],
    )
    if (options.location !== false) {
      await pool.query(
        `INSERT INTO message_location (message_id, folder_id, uidvalidity, uid)
         VALUES ($1, $2, 1, nextval('message_location_placeholder_seq'))`,
        [id, folderId],
      )
    }
    let file: string | null = null
    if (options.file !== false) {
      file = await writeRaw(dataDir, accountId, id)
      await pool.query(`INSERT INTO message_body (message_id, storage_ref) VALUES ($1, $2)`, [
        id,
        path.join(accountId, id, 'raw.eml.enc'),
      ])
    }
    return { id, file }
  }

  async function messageExists(id: string): Promise<boolean> {
    const { rowCount } = await pool.query('SELECT 1 FROM message WHERE id = $1', [id])
    return (rowCount ?? 0) > 0
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl })
    await runMigrations(pool)
    dataDir = await mkdtemp(path.join(tmpdir(), 'fma-cleanup5-'))
    process.env.MAIL_DATA_DIR = dataDir
  })

  beforeEach(async () => {
    await pool.query(`TRUNCATE ${TABLES} CASCADE`)
    await rm(dataDir, { recursive: true, force: true })
    await mkdir(dataDir, { recursive: true })
    const user = await pool.query<{ id: string }>(
      `INSERT INTO "user" (email, password_hash) VALUES ($1, 'x') RETURNING id`,
      [`cleanup5-${Date.now()}@example.com`],
    )
    userId = user.rows[0]!.id
    accountId = randomUUID()
    await pool.query(
      `INSERT INTO mail_account
         (id, user_id, display_name, email_address, imap_host, imap_port,
          smtp_host, smtp_port, wrapped_dek, key_id, credential_enc)
       VALUES ($1, $2, 'Clean', 'clean@example.com', 'imap.test', 993,
         'smtp.test', 465, '\\x00', 'v1', '\\x00')`,
      [accountId, userId],
    )
    const folder = await pool.query<{ id: string }>(
      `INSERT INTO folder (account_id, path) VALUES ($1, 'INBOX') RETURNING id`,
      [accountId],
    )
    folderId = folder.rows[0]!.id
  })

  afterAll(async () => {
    await pool.query(`TRUNCATE ${TABLES} CASCADE`)
    await pool.end()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('has sensible defaults and reads the environment', () => {
    // Uploads: 7 days by default, so offline-queued sends keep their files.
    expect(cleanupSettings()).toEqual({ ...SETTINGS, uploadRetentionMs: 7 * 24 * HOUR })
    process.env.UPLOAD_RETENTION_HOURS = '2'
    try {
      expect(cleanupSettings().uploadRetentionMs).toBe(2 * HOUR)
    } finally {
      delete process.env.UPLOAD_RETENTION_HOURS
    }
  })

  it('removes messages without location and their files, keeps the others', async () => {
    const kept = await insertMessage()
    const orphan = await insertMessage({ location: false })
    const orphanNoBody = await insertMessage({ location: false, file: false })

    const outcome = await runCleanup(pool, SETTINGS)
    expect(outcome.messages).toBe(2)
    expect(await messageExists(kept.id)).toBe(true)
    expect(await exists(kept.file!)).toBe(true)
    expect(await messageExists(orphan.id)).toBe(false)
    expect(await exists(orphan.file!)).toBe(false)
    expect(await exists(path.dirname(orphan.file!))).toBe(false)
    expect(await messageExists(orphanNoBody.id)).toBe(false)
  })

  it('leaves messages without location alone while the account is busy', async () => {
    const orphan = await insertMessage({ location: false })
    // A running sync may be relinking it (UIDVALIDITY change).
    await pool.query(
      `INSERT INTO job (type, account_id, state, locked_at) VALUES ('message_sync', $1, 'running', now())`,
      [accountId],
    )
    expect(await purgeLocationlessMessages(pool, accountId, true)).toBe(0)
    expect(await messageExists(orphan.id)).toBe(true)

    // A pending expunge (message_action) owns it as well.
    await pool.query(`UPDATE job SET state = 'done'`)
    await pool.query(`INSERT INTO job (type, account_id) VALUES ('message_action', $1)`, [
      accountId,
    ])
    expect(await purgeLocationlessMessages(pool, accountId, true)).toBe(0)

    await pool.query(`UPDATE job SET state = 'done'`)
    expect(await purgeLocationlessMessages(pool, accountId, true)).toBe(1)
    expect(await messageExists(orphan.id)).toBe(false)
    expect(await exists(orphan.file!)).toBe(false)
  })

  it('removes old unbound uploads and uploads of settled messages', async () => {
    const insertOutbox = async (status: string, contentEnc: string | null, ageDays = 0) => {
      const id = randomUUID()
      await pool.query(
        `INSERT INTO outbox_message (id, account_id, status, content_enc, message_id_header,
           sent_copy, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now() - ($7 || ' days')::interval)`,
        [
          id,
          accountId,
          status,
          contentEnc,
          `<${id}@example.org>`,
          status === 'sent' ? 'done' : null,
          String(ageDays),
        ],
      )
      return id
    }
    const insertUpload = async (outboxId: string | null, ageHours: number) => {
      const id = randomUUID()
      await pool.query(
        `INSERT INTO attachment_upload (id, account_id, outbox_id, filename_enc, content_type,
           size_bytes, content_enc, created_at)
         VALUES ($1, $2, $3, '\\x00', 'text/plain', 1, '\\x00',
           now() - ($4 || ' hours')::interval)`,
        [id, accountId, outboxId, String(ageHours)],
      )
      return id
    }
    const queuedOutbox = await insertOutbox('queued', '\\x01')
    const failedRecent = await insertOutbox('failed', '\\x01', 2)
    const failedOld = await insertOutbox('failed', '\\x01', 31)
    const sentSettled = await insertOutbox('sent', null, 1)
    const sentOld = await insertOutbox('sent', null, 31)

    const unboundOld = await insertUpload(null, 25)
    const unboundYoung = await insertUpload(null, 1)
    const boundQueued = await insertUpload(queuedOutbox, 48)
    const boundFailed = await insertUpload(failedRecent, 48)
    const boundSettled = await insertUpload(sentSettled, 2)
    const boundFailedOld = await insertUpload(failedOld, 48)

    const outcome = await runCleanup(pool, SETTINGS)
    const { rows: uploads } = await pool.query<{ id: string }>(
      'SELECT id::text FROM attachment_upload',
    )
    const left = uploads.map((row) => row.id).sort()
    expect(left).toEqual([unboundYoung, boundQueued, boundFailed].sort())
    expect(left).not.toContain(unboundOld)
    expect(left).not.toContain(boundSettled)
    expect(left).not.toContain(boundFailedOld)
    expect(outcome.uploads).toBe(2)

    const { rows: outbox } = await pool.query<{ id: string }>('SELECT id::text FROM outbox_message')
    expect(outbox.map((row) => row.id).sort()).toEqual(
      [queuedOutbox, failedRecent, sentSettled].sort(),
    )
    expect(outbox.map((row) => row.id)).not.toContain(sentOld)
    expect(outcome.outbox).toBe(2)
  })

  it('keeps an upload bound and a message re-queued concurrently with the cleanup', async () => {
    const outboxId = randomUUID()
    await pool.query(
      `INSERT INTO outbox_message (id, account_id, status, content_enc, message_id_header,
         updated_at)
       VALUES ($1, $2, 'failed', '\\x01', $3, now() - interval '40 days')`,
      [outboxId, accountId, `<${outboxId}@example.org>`],
    )
    const uploadId = randomUUID()
    await pool.query(
      `INSERT INTO attachment_upload (id, account_id, filename_enc, content_type,
         size_bytes, content_enc, created_at)
       VALUES ($1, $2, '\\x00', 'text/plain', 1, '\\x00', now() - interval '10 days')`,
      [uploadId, accountId],
    )
    // Another transaction binds the old upload (POST /api/outbox) and
    // retries the old failed message while the cleanup runs.
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `UPDATE outbox_message SET status = 'queued', updated_at = now() WHERE id = $1`,
        [outboxId],
      )
      await client.query(`UPDATE attachment_upload SET outbox_id = $1 WHERE id = $2`, [
        outboxId,
        uploadId,
      ])
      const cleanup = runCleanup(pool, SETTINGS)
      await new Promise((resolve) => setTimeout(resolve, 300))
      await client.query('COMMIT')
      await cleanup
    } finally {
      client.release()
    }
    const { rows: upload } = await pool.query('SELECT 1 FROM attachment_upload WHERE id = $1', [
      uploadId,
    ])
    expect(upload).toHaveLength(1)
    const { rows: outbox } = await pool.query<{ status: string }>(
      'SELECT status FROM outbox_message WHERE id = $1',
      [outboxId],
    )
    expect(outbox[0]?.status).toBe('queued')
    await pool.query('DELETE FROM outbox_message WHERE id = $1', [outboxId])
  })

  it('removes old finished and failed jobs, never queued or running ones', async () => {
    const insertJob = async (state: string, ageDays: number) => {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO job (type, state, run_at, created_at)
         VALUES ('folder_sync', $1, now() - ($2 || ' days')::interval,
           now() - ($2 || ' days')::interval)
         RETURNING id::text`,
        [state, String(ageDays)],
      )
      return rows[0]!.id
    }
    await insertJob('done', 8)
    const doneNew = await insertJob('done', 1)
    const failedMid = await insertJob('failed', 8)
    await insertJob('failed', 31)
    const queuedOld = await insertJob('queued', 60)
    const runningOld = await insertJob('running', 60)

    const outcome = await runCleanup(pool, SETTINGS)
    expect(outcome.jobs).toBe(2)
    const { rows } = await pool.query<{ id: string }>('SELECT id::text FROM job ORDER BY id')
    expect(rows.map((row) => row.id)).toEqual([doneNew, failedMid, queuedOld, runningOld])
  })

  it('removes expired sessions and long-disabled push subscriptions', async () => {
    const device = await pool.query<{ id: string }>(
      `INSERT INTO device (user_id, name, platform, installation_id)
       VALUES ($1, 'Phone', 'ios_pwa', gen_random_uuid()) RETURNING id`,
      [userId],
    )
    const deviceId = device.rows[0]!.id
    await pool.query(
      `INSERT INTO session (device_id, token_hash, expires_at) VALUES
         ($1, $2, now() - interval '1 minute'), ($1, $3, now() + interval '1 day')`,
      [deviceId, randomBytes(32), randomBytes(32)],
    )
    await pool.query(
      `INSERT INTO push_subscription (device_id, transport, endpoint, keys_enc, disabled_at) VALUES
         ($1, 'webpush', 'https://push.example.net/a', '\\x00', NULL),
         ($1, 'webpush', 'https://push.example.net/b', '\\x00', now() - interval '1 day'),
         ($1, 'webpush', 'https://push.example.net/c', '\\x00', now() - interval '31 days')`,
      [deviceId],
    )

    const outcome = await runCleanup(pool, SETTINGS)
    expect(outcome.sessions).toBe(1)
    expect(outcome.pushSubscriptions).toBe(1)
    const sessions = await pool.query('SELECT 1 FROM session WHERE expires_at > now()')
    expect(sessions.rowCount).toBe(1)
    const { rows } = await pool.query<{ endpoint: string }>(
      'SELECT endpoint FROM push_subscription ORDER BY endpoint',
    )
    expect(rows.map((row) => row.endpoint)).toEqual([
      'https://push.example.net/a',
      'https://push.example.net/b',
    ])
  })

  it('removes unreferenced files in the volume only after the grace period', async () => {
    const old = 25 * HOUR
    const referenced = await insertMessage()
    // Backdate the referenced file: age alone must never delete it.
    const time = new Date(Date.now() - old)
    await utimes(referenced.file!, time, time)
    await utimes(path.dirname(referenced.file!), time, time)

    const orphanOld = await writeRaw(dataDir, accountId, randomUUID(), old)
    const orphanNew = await writeRaw(dataDir, accountId, randomUUID())
    // Body row without file reference (skip marker) does not protect a dir.
    const skipped = await insertMessage({ file: false })
    await pool.query(
      `INSERT INTO message_body (message_id, storage_ref, skip_reason) VALUES ($1, NULL, 'too_large')`,
      [skipped.id],
    )
    const skippedFile = await writeRaw(dataDir, accountId, skipped.id, old)
    // Directories of an account that no longer exists.
    const goneAccount = randomUUID()
    const goneOld = await writeRaw(dataDir, goneAccount, randomUUID(), old)
    await utimes(path.join(dataDir, goneAccount), time, time)
    const newAccount = randomUUID()
    const newAccountFile = await writeRaw(dataDir, newAccount, randomUUID())
    // Anything outside our layout is left alone.
    await writeFile(path.join(dataDir, 'README'), 'not ours')
    await utimes(path.join(dataDir, 'README'), time, time)

    const outcome = await removeOrphanFiles(pool, SETTINGS.orphanFileGraceMs)
    expect(outcome).toEqual({ messageDirs: 2, accountDirs: 1 })
    expect(await exists(referenced.file!)).toBe(true)
    expect(await exists(orphanOld)).toBe(false)
    expect(await exists(path.dirname(orphanOld))).toBe(false)
    expect(await exists(orphanNew)).toBe(true)
    expect(await exists(skippedFile)).toBe(false)
    expect(await exists(goneOld)).toBe(false)
    expect(await exists(path.join(dataDir, goneAccount))).toBe(false)
    expect(await exists(newAccountFile)).toBe(true)
    expect((await readdir(dataDir)).sort()).toEqual([accountId, newAccount, 'README'].sort())
  })

  it('scans many directories in batches', async () => {
    const old = 25 * HOUR
    for (let i = 0; i < 1203; i++) await writeRaw(dataDir, accountId, randomUUID(), old)
    const kept = await insertMessage()
    const outcome = await removeOrphanFiles(pool, SETTINGS.orphanFileGraceMs)
    expect(outcome.messageDirs).toBe(1203)
    expect(await readdir(path.join(dataDir, accountId))).toEqual([kept.id])
  })

  it('enqueues the periodic cleanup once per interval', async () => {
    expect(await enqueueDueCleanup(pool, 3600)).toBe(true)
    expect(await enqueueDueCleanup(pool, 3600)).toBe(false) // queued
    await pool.query(`UPDATE job SET state = 'done' WHERE type = 'cleanup'`)
    expect(await enqueueDueCleanup(pool, 3600)).toBe(false) // too recent
    await pool.query(
      `UPDATE job SET created_at = now() - interval '2 hours' WHERE type = 'cleanup'`,
    )
    expect(await enqueueDueCleanup(pool, 3600)).toBe(true)
  })
})

describe.skipIf(!databaseUrl || !greenmailHost)('cleanup with the provider', () => {
  let pool: pg.Pool
  let dataDir: string
  let accountId: string
  const folderPath = `Cleanup-${Date.now()}`

  function imap(): ImapFlow {
    return new ImapFlow({
      host: greenmailHost!,
      port: Number(process.env.GREENMAIL_IMAP_PORT),
      secure: false,
      auth: { user: greenmailUser, pass: greenmailPassword },
      logger: false,
      tls: { rejectUnauthorized: false },
      doSTARTTLS: false,
    })
  }

  async function folderId(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      'SELECT id::text FROM folder WHERE account_id = $1 AND path = $2',
      [accountId, folderPath],
    )
    return rows[0]!.id
  }

  async function storedFiles(folder: string): Promise<{ id: string; file: string }[]> {
    const { rows } = await pool.query<{ id: string; storage_ref: string }>(
      `SELECT DISTINCT m.id::text, mb.storage_ref FROM message m
       JOIN message_location ml ON ml.message_id = m.id
       JOIN message_body mb ON mb.message_id = m.id
       WHERE ml.folder_id = $1 AND mb.storage_ref IS NOT NULL`,
      [folder],
    )
    return rows.map((row) => ({ id: row.id, file: path.join(dataDir, row.storage_ref) }))
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl })
    await runMigrations(pool)
    await pool.query(`TRUNCATE ${TABLES} CASCADE`)
    dataDir = await mkdtemp(path.join(tmpdir(), 'fma-cleanup5-imap-'))
    process.env.MAIL_DATA_DIR = dataDir

    const user = await pool.query<{ id: string }>(
      `INSERT INTO "user" (email, password_hash) VALUES ($1, 'x') RETURNING id`,
      [`cleanup5-imap-${Date.now()}@example.com`],
    )
    accountId = randomUUID()
    const dek = generateDataKey()
    const wrappedDek = wrapDataKey(
      loadMasterKey(process.env.MASTER_KEY!),
      dek,
      process.env.MASTER_KEY_ID ?? 'v1',
    )
    const credentialEnc = Buffer.from(
      encryptField(
        dek,
        JSON.stringify({ imapUser: greenmailUser, imapPassword: greenmailPassword }),
        `mail_account.credential:${accountId}`,
      ),
      'utf8',
    )
    await pool.query(
      `INSERT INTO mail_account
         (id, user_id, display_name, email_address, imap_host, imap_port,
          smtp_host, smtp_port, wrapped_dek, key_id, credential_enc, status)
       VALUES ($1, $2, 'Cleanup', $3, $4, $5, 'smtp.test', 465, $6, $7, $8, 'ok')`,
      [
        accountId,
        user.rows[0]!.id,
        greenmailUser,
        greenmailHost,
        Number(process.env.GREENMAIL_IMAP_PORT),
        wrappedDek,
        process.env.MASTER_KEY_ID ?? 'v1',
        credentialEnc,
      ],
    )

    // A folder with two mails on the provider, synced (rows + files).
    const client = imap()
    await client.connect()
    try {
      await client.mailboxCreate(folderPath)
      for (const n of [1, 2]) {
        await client.append(
          folderPath,
          `From: a@example.org\r\nTo: b@example.org\r\nSubject: Cleanup ${n}\r\n` +
            `Message-ID: <cleanup-${n}-${folderPath}@example.org>\r\n\r\nBody ${n}\r\n`,
        )
      }
    } finally {
      await client.logout().catch(() => client.close())
    }
    await runFolderSync(pool, accountId)
    await runMessageSync(pool, accountId, await folderId())
  })

  afterAll(async () => {
    const client = imap()
    await client.connect()
    await client.mailboxDelete(folderPath).catch(() => {})
    await client.logout().catch(() => client.close())
    await pool.query(`TRUNCATE ${TABLES} CASCADE`)
    await pool.end()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('removes messages and files left over by an interrupted UIDVALIDITY resync', async () => {
    const folder = await folderId()
    const before = await storedFiles(folder)
    expect(before).toHaveLength(2)

    // A previous attempt discarded the stale locations and died before
    // removing the messages that did not come back: the ghost has a body
    // file but no location, and folder.uidvalidity is still the old one.
    const { rows } = await pool.query<{ uidvalidity: string }>(
      'SELECT uidvalidity::text FROM folder WHERE id = $1',
      [folder],
    )
    const stale = (BigInt(rows[0]!.uidvalidity) - 1n).toString()
    await pool.query('UPDATE folder SET uidvalidity = $2 WHERE id = $1', [folder, stale])
    const ghost = randomUUID()
    await pool.query(
      `INSERT INTO message (id, account_id, message_id_header, subject_enc, from_enc,
         recipients_enc, snippet_enc)
       VALUES ($1, $2, '<ghost-cleanup@example.org>', '\\x00', '\\x00', '\\x00', '\\x00')`,
      [ghost, accountId],
    )
    const ghostFile = await writeRaw(dataDir, accountId, ghost)
    await pool.query('INSERT INTO message_body (message_id, storage_ref) VALUES ($1, $2)', [
      ghost,
      path.join(accountId, ghost, 'raw.eml.enc'),
    ])

    await runMessageSync(pool, accountId, folder)

    const ghostRow = await pool.query('SELECT 1 FROM message WHERE id = $1', [ghost])
    expect(ghostRow.rowCount).toBe(0)
    expect(await exists(ghostFile)).toBe(false)
    // The real messages and their files stay.
    const after = await storedFiles(folder)
    expect(after.map((row) => row.id).sort()).toEqual(before.map((row) => row.id).sort())
    for (const row of after) expect(await exists(row.file)).toBe(true)
  })

  it('removes messages and files of a folder deleted on the provider', async () => {
    const folder = await folderId()
    const files = await storedFiles(folder)
    expect(files).toHaveLength(2)
    const otherMessages = await pool.query<{ count: number }>(
      `SELECT count(DISTINCT ml.message_id)::int AS count FROM message_location ml
       JOIN folder f ON f.id = ml.folder_id WHERE f.account_id = $1 AND f.id <> $2`,
      [accountId, folder],
    )

    const client = imap()
    await client.connect()
    try {
      await client.mailboxDelete(folderPath)
    } finally {
      await client.logout().catch(() => client.close())
    }
    await runFolderSync(pool, accountId)

    const gone = await pool.query('SELECT 1 FROM folder WHERE id = $1', [folder])
    expect(gone.rowCount).toBe(0)
    for (const row of files) {
      const message = await pool.query('SELECT 1 FROM message WHERE id = $1', [row.id])
      expect(message.rowCount).toBe(0)
      expect(await exists(row.file)).toBe(false)
      expect(await exists(path.dirname(row.file))).toBe(false)
    }
    // Messages of other folders are untouched.
    const remaining = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM message WHERE account_id = $1',
      [accountId],
    )
    expect(remaining.rows[0]!.count).toBe(otherMessages.rows[0]!.count)
  })
})
