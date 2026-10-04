/**
 * Integration tests for the draft_sync job (roadmap 2.8) against GreenMail:
 * APPEND to the Drafts folder with \Draft, replacing the previous version
 * (and a draft written in another client), removal after discard/send, and
 * accounts without a Drafts folder. Requires DATABASE_URL + GreenMail;
 * skipped when unset.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import pg from 'pg'
import { ImapFlow } from 'imapflow'
import { runMigrations } from '@fma/db/migrate'
import { simpleParser } from 'mailparser'
import {
  draftContentAad,
  encryptBytes,
  encryptField,
  generateDataKey,
  loadMasterKey,
  uploadFieldAad,
  wrapDataKey,
} from '@fma/crypto'
import type { DraftContent } from '@fma/shared'
import { draftMessageId, runDraftSync } from '../src/jobs/draft-sync'

process.env.MASTER_KEY ??= randomBytes(32).toString('base64')

const databaseUrl = process.env.DATABASE_URL
const greenmailHost = process.env.GREENMAIL_HOST
const greenmailUser = process.env.GREENMAIL_USER ?? ''
const greenmailPassword = process.env.GREENMAIL_PASSWORD ?? ''

const TABLES =
  'session, device, "user", mail_account, identity, folder, job, message, message_location, draft, attachment_upload'
const DRAFTS = 'FmaDraftSync'

function imapClient(): ImapFlow {
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

interface StoredCopy {
  uid: number
  flags: string[]
  messageId: string | undefined
  source: string
}

/** All messages of the test Drafts folder. */
async function folderContents(): Promise<StoredCopy[]> {
  const client = imapClient()
  await client.connect()
  const lock = await client.getMailboxLock(DRAFTS)
  try {
    const status = client.mailbox
    if (!status || status.exists === 0) return []
    const found: StoredCopy[] = []
    for await (const msg of client.fetch('1:*', {
      uid: true,
      envelope: true,
      source: true,
      flags: true,
    })) {
      found.push({
        uid: msg.uid,
        flags: [...(msg.flags ?? [])],
        messageId: msg.envelope?.messageId,
        source: msg.source?.toString('utf8') ?? '',
      })
    }
    return found
  } finally {
    lock.release()
    await client.logout().catch(() => client.close())
  }
}

describe.skipIf(!databaseUrl || !greenmailHost)('draft_sync job', () => {
  let pool: pg.Pool
  let accountId: string
  let dek: Buffer
  let draftsFolderId: string
  let uidValidity: string

  async function saveDraft(
    id: string,
    version: number,
    content: Partial<DraftContent> = {},
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const full: DraftContent = {
      to: 'Anna <anna@example.com>, unvollständig@',
      cc: '',
      bcc: 'geheim@example.com',
      subject: 'Entwurf',
      text: 'Noch nicht fertig.',
      ...content,
    }
    const enc = Buffer.from(encryptField(dek, JSON.stringify(full), draftContentAad(id)), 'utf8')
    await pool.query(
      `INSERT INTO draft (id, account_id, content_enc, version, in_reply_to, source_folder_id,
                          source_uidvalidity, source_uid)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET content_enc = $3, version = $4, updated_at = now()`,
      [
        id,
        accountId,
        enc,
        version,
        extra.inReplyTo ?? null,
        extra.sourceFolderId ?? null,
        extra.sourceUidvalidity ?? null,
        extra.sourceUid ?? null,
      ],
    )
  }

  async function draftRow(id: string) {
    const { rows } = await pool.query<{
      imap_version: number
      message_id_header: string | null
      source_uid: string | null
    }>('SELECT imap_version, message_id_header, source_uid FROM draft WHERE id = $1', [id])
    return rows[0]
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl })
    await runMigrations(pool)
    await pool.query(`TRUNCATE ${TABLES} CASCADE`)

    const user = await pool.query<{ id: string }>(
      `INSERT INTO "user" (email, password_hash) VALUES ($1, 'not-a-real-hash') RETURNING id`,
      [`drafts-${Date.now()}@example.com`],
    )
    accountId = randomUUID()
    dek = generateDataKey()
    await pool.query(
      `INSERT INTO mail_account
         (id, user_id, display_name, email_address, imap_host, imap_port,
          smtp_host, smtp_port, wrapped_dek, key_id, credential_enc, status)
       VALUES ($1, $2, 'Draft-Test', $3, $4, $5, $4, $6, $7, 'v1', $8, 'ok')`,
      [
        accountId,
        user.rows[0]!.id,
        greenmailUser,
        greenmailHost,
        Number(process.env.GREENMAIL_IMAP_PORT),
        Number(process.env.GREENMAIL_SMTP_PORT),
        wrapDataKey(loadMasterKey(process.env.MASTER_KEY!), dek, 'v1'),
        Buffer.from(
          encryptField(
            dek,
            JSON.stringify({ imapUser: greenmailUser, imapPassword: greenmailPassword }),
            `mail_account.credential:${accountId}`,
          ),
          'utf8',
        ),
      ],
    )
    await pool.query(
      `INSERT INTO identity (account_id, name, email_address) VALUES ($1, 'Ich Selbst', $2)`,
      [accountId, greenmailUser],
    )
  })

  beforeEach(async () => {
    await pool.query('DELETE FROM job')
    await pool.query('DELETE FROM draft')
    await pool.query('DELETE FROM folder WHERE account_id = $1', [accountId])
    const setup = imapClient()
    await setup.connect()
    await setup.mailboxDelete(DRAFTS).catch(() => {})
    await setup.mailboxCreate(DRAFTS)
    const status = await setup.status(DRAFTS, { uidValidity: true })
    uidValidity = String(status ? status.uidValidity : '')
    await setup.logout().catch(() => setup.close())
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO folder (account_id, path, delimiter, special_use, uidvalidity)
       VALUES ($1, $2, '.', 'drafts', $3) RETURNING id`,
      [accountId, DRAFTS, uidValidity],
    )
    draftsFolderId = rows[0]!.id
  })

  afterAll(async () => {
    const cleanup = imapClient()
    await cleanup.connect()
    await cleanup.mailboxDelete(DRAFTS).catch(() => {})
    await cleanup.logout().catch(() => cleanup.close())
    await pool.query(`TRUNCATE ${TABLES} CASCADE`)
    await pool.end()
  })

  it('uploads a draft with \\Draft and replaces the previous version', async () => {
    const id = randomUUID()
    await saveDraft(id, 1, { subject: 'Erste Fassung' }, { inReplyTo: '<orig@example.com>' })
    expect(await runDraftSync(pool, accountId, { draftId: id })).toBe('uploaded')

    let copies = await folderContents()
    expect(copies).toHaveLength(1)
    expect(copies[0]!.flags).toEqual(expect.arrayContaining(['\\Draft', '\\Seen']))
    expect(copies[0]!.messageId).toBe(draftMessageId(id, 1, greenmailUser))
    expect(copies[0]!.source).toContain('Subject: Erste Fassung')
    expect(copies[0]!.source).toContain('In-Reply-To: <orig@example.com>')
    expect(copies[0]!.source).toMatch(/^From: .*Ich Selbst/m)
    // Only valid addresses of the typed field; Bcc kept in the own copy.
    expect(copies[0]!.source).toMatch(/^To: Anna <anna@example\.com>\r?$/m)
    expect(copies[0]!.source).toContain('geheim@example.com')
    expect(await draftRow(id)).toMatchObject({
      imap_version: 1,
      message_id_header: draftMessageId(id, 1, greenmailUser),
    })
    // The Drafts folder is resynced.
    const { rows: jobs } = await pool.query(
      `SELECT payload FROM job WHERE type = 'message_sync' AND account_id = $1`,
      [accountId],
    )
    expect(jobs).toEqual([{ payload: { folderId: draftsFolderId } }])

    // Nothing to do while the upload is current.
    expect(await runDraftSync(pool, accountId, { draftId: id })).toBe('up_to_date')

    await saveDraft(id, 2, { subject: 'Zweite Fassung' })
    expect(await runDraftSync(pool, accountId, { draftId: id })).toBe('uploaded')
    copies = await folderContents()
    expect(copies).toHaveLength(1)
    expect(copies[0]!.source).toContain('Subject: Zweite Fassung')
    expect(copies[0]!.messageId).toBe(draftMessageId(id, 2, greenmailUser))
  })

  it('includes the attachments kept with the draft in the IMAP copy', async () => {
    const id = randomUUID()
    await saveDraft(id, 1, { subject: 'Mit Anhang' })
    const pdf = randomBytes(50_000)
    const uploadId = randomUUID()
    await pool.query(
      `INSERT INTO attachment_upload
         (id, account_id, draft_id, filename_enc, content_type, size_bytes, content_enc)
       VALUES ($1, $2, $3, $4, 'application/pdf', $5, $6)`,
      [
        uploadId,
        accountId,
        id,
        Buffer.from(
          encryptField(dek, 'Angebot ä.pdf', uploadFieldAad('filename', uploadId)),
          'utf8',
        ),
        pdf.length,
        encryptBytes(dek, pdf, uploadFieldAad('content', uploadId)),
      ],
    )
    expect(await runDraftSync(pool, accountId, { draftId: id })).toBe('uploaded')
    const copies = await folderContents()
    expect(copies).toHaveLength(1)
    const parsed = await simpleParser(copies[0]!.source)
    expect(parsed.text?.trim()).toBe('Noch nicht fertig.')
    expect(parsed.attachments.map((a) => [a.filename, a.contentType])).toEqual([
      ['Angebot ä.pdf', 'application/pdf'],
    ])
    expect(parsed.attachments[0]!.content.equals(pdf)).toBe(true)

    // Discarded: the copy goes, and the uploads with the draft row.
    await pool.query('UPDATE draft SET deleted_at = now(), content_enc = NULL WHERE id = $1', [id])
    expect(await runDraftSync(pool, accountId, { draftId: id })).toBe('removed')
    expect(await folderContents()).toHaveLength(0)
    const { rows } = await pool.query('SELECT 1 FROM attachment_upload WHERE id = $1', [uploadId])
    expect(rows).toHaveLength(0)
  })

  it('cleans up copies left over by an interrupted upload', async () => {
    const id = randomUUID()
    await saveDraft(id, 1)
    await runDraftSync(pool, accountId, { draftId: id })
    // Crash between APPEND and the database update: imap_version stays behind.
    await pool.query('UPDATE draft SET imap_version = 0 WHERE id = $1', [id])
    await runDraftSync(pool, accountId, { draftId: id })
    expect(await folderContents()).toHaveLength(1)
  })

  it('replaces a draft written in another client on the first upload', async () => {
    const setup = imapClient()
    await setup.connect()
    const appended = await setup.append(
      DRAFTS,
      Buffer.from(
        'From: me@example.com\r\nTo: anna@example.com\r\nSubject: Aus Thunderbird\r\n' +
          'Message-ID: <tb-draft@example.com>\r\n\r\nHalbfertig\r\n',
      ),
      ['\\Draft'],
    )
    await setup.logout().catch(() => setup.close())
    const foreignUid = appended && appended.uid ? appended.uid : 1

    const id = randomUUID()
    await saveDraft(
      id,
      2,
      { subject: 'Aus Thunderbird, weitergeschrieben' },
      { sourceFolderId: draftsFolderId, sourceUidvalidity: uidValidity, sourceUid: foreignUid },
    )
    await pool.query('UPDATE draft SET imap_version = 1 WHERE id = $1', [id])
    expect(await runDraftSync(pool, accountId, { draftId: id })).toBe('uploaded')

    const copies = await folderContents()
    expect(copies.map((c) => c.messageId)).toEqual([draftMessageId(id, 2, greenmailUser)])
    expect(await draftRow(id)).toMatchObject({ source_uid: null, imap_version: 2 })
  })

  it('keeps the source copy when not all of its attachments were copied (keep_source)', async () => {
    const setup = imapClient()
    await setup.connect()
    const appended = await setup.append(
      DRAFTS,
      Buffer.from(
        'From: me@example.com\r\nTo: anna@example.com\r\nSubject: Mit Anhang\r\n' +
          'Message-ID: <tb-attach@example.com>\r\n\r\nSiehe Anhang\r\n',
      ),
      ['\\Draft'],
    )
    await setup.logout().catch(() => setup.close())
    const foreignUid = appended && appended.uid ? appended.uid : 1

    const id = randomUUID()
    await saveDraft(
      id,
      2,
      { subject: 'Mit Anhang, weitergeschrieben' },
      { sourceFolderId: draftsFolderId, sourceUidvalidity: uidValidity, sourceUid: foreignUid },
    )
    await pool.query('UPDATE draft SET imap_version = 1, keep_source = true WHERE id = $1', [id])
    expect(await runDraftSync(pool, accountId, { draftId: id })).toBe('uploaded')
    expect((await folderContents()).map((c) => c.messageId).sort()).toEqual(
      ['<tb-attach@example.com>', draftMessageId(id, 2, greenmailUser)].sort(),
    )

    // Discarding removes only the app's own copy, never the original.
    await pool.query('UPDATE draft SET deleted_at = now(), content_enc = NULL WHERE id = $1', [id])
    expect(await runDraftSync(pool, accountId, { draftId: id })).toBe('removed')
    expect((await folderContents()).map((c) => c.messageId)).toEqual(['<tb-attach@example.com>'])
  })

  it('removes the copy once the draft is discarded or sent, then deletes the row', async () => {
    const id = randomUUID()
    await saveDraft(id, 1)
    await runDraftSync(pool, accountId, { draftId: id })
    expect(await folderContents()).toHaveLength(1)

    // Same update as DELETE /api/drafts/:id and POST /api/outbox with draftId.
    await pool.query('UPDATE draft SET deleted_at = now(), content_enc = NULL WHERE id = $1', [id])
    expect(await runDraftSync(pool, accountId, { draftId: id })).toBe('removed')
    expect(await folderContents()).toEqual([])
    expect(await draftRow(id)).toBeUndefined()
    expect(await runDraftSync(pool, accountId, { draftId: id })).toBe('missing')
  })

  it('keeps drafts server-only without a Drafts folder', async () => {
    await pool.query('UPDATE folder SET special_use = NULL WHERE id = $1', [draftsFolderId])
    const id = randomUUID()
    await saveDraft(id, 3)
    expect(await runDraftSync(pool, accountId, { draftId: id })).toBe('no_drafts_folder')
    expect(await draftRow(id)).toMatchObject({ imap_version: 3 })
    expect(await folderContents()).toEqual([])

    await pool.query('UPDATE draft SET deleted_at = now() WHERE id = $1', [id])
    expect(await runDraftSync(pool, accountId, { draftId: id })).toBe('removed')
    expect(await draftRow(id)).toBeUndefined()
  })
})
