/**
 * Restore test (roadmap 6.2): fills an instance (account with encrypted
 * credentials, message, encrypted raw mail files), creates an encrypted
 * backup, restores it into a freshly created database + empty directory and
 * checks that everything is identical and decryptable. Wrong key, truncated
 * files, non-empty targets and backups from newer versions must fail.
 * Requires DATABASE_URL and pg_dump/pg_restore (PG_BIN) >= server version.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { runMigrations, migrations } from '@fma/db/migrate'
import {
  BackupDecryptError,
  decryptBytes,
  decryptField,
  encryptBytes,
  encryptField,
  generateDataKey,
  loadMasterKey,
  messageFieldAad,
  wrapDataKey,
} from '@fma/crypto'
import { loadAccountContext } from '../src/accounts'
import {
  BackupError,
  createBackup,
  pgTargetFromEnv,
  restoreBackup,
  type PgTarget,
} from '../src/backup'

const databaseUrl = process.env.DATABASE_URL
const MASTER_KEY = randomBytes(32).toString('base64')
const WRONG_KEY = randomBytes(32).toString('base64')
const TABLES =
  'session, device, push_subscription, "user", mail_account, identity, folder, job, message, message_location, message_body, thread, outbox_message, attachment_upload'

describe.skipIf(!databaseUrl)('backup and restore', () => {
  let pool: pg.Pool
  let source: PgTarget
  let workDir: string
  let sourceDir: string
  let backupFile: string
  const createdDbs: string[] = []
  let accountId: string
  let messageId: string
  const raw = Buffer.from('From: a@example.org\r\nSubject: Restore me\r\n\r\nHello backup\r\n')
  const bigFile = randomBytes(300 * 1024)

  async function freshDatabase(): Promise<PgTarget> {
    const name = `fma_restore_${randomUUID().replace(/-/g, '').slice(0, 12)}`
    await pool.query(`CREATE DATABASE ${name}`)
    createdDbs.push(name)
    return { ...source, database: name }
  }

  async function backup(file: string): Promise<void> {
    await createBackup({
      db: source,
      mailDataDir: sourceDir,
      masterKey: MASTER_KEY,
      output: createWriteStream(file, { mode: 0o600 }),
    })
  }

  async function restore(
    file: string,
    db: PgTarget,
    dir: string,
    extra: { masterKey?: string; force?: boolean; verifyOnly?: boolean } = {},
  ) {
    return restoreBackup({
      db,
      mailDataDir: dir,
      masterKey: extra.masterKey ?? MASTER_KEY,
      input: createReadStream(file),
      force: extra.force,
      verifyOnly: extra.verifyOnly,
    })
  }

  async function tableCount(db: PgTarget): Promise<number> {
    const client = new pg.Client(db)
    await client.connect()
    try {
      const { rows } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`,
      )
      return rows[0]!.n
    } finally {
      await client.end()
    }
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl })
    source = pgTargetFromEnv({ DATABASE_URL: databaseUrl })
    await runMigrations(pool)
    await pool.query(`TRUNCATE ${TABLES} CASCADE`)
    workDir = await mkdtemp(path.join(tmpdir(), 'fma-backup-'))
    sourceDir = path.join(workDir, 'mail-data')
    backupFile = path.join(workDir, 'instance.fmabk')

    const masterKey = loadMasterKey(MASTER_KEY)
    const user = await pool.query<{ id: string }>(
      `INSERT INTO "user" (email, password_hash) VALUES ('backup@example.com', 'x') RETURNING id`,
    )
    accountId = randomUUID()
    const dek = generateDataKey()
    const credential = encryptField(
      dek,
      JSON.stringify({ imapUser: 'backup-user', imapPassword: 'backup-secret' }),
      `mail_account.credential:${accountId}`,
    )
    await pool.query(
      `INSERT INTO mail_account
         (id, user_id, display_name, email_address, imap_host, imap_port,
          smtp_host, smtp_port, wrapped_dek, key_id, credential_enc)
       VALUES ($1, $2, 'Backup', 'backup@example.com', 'imap.backup-host.test', 993,
         'smtp.backup-host.test', 465, $3, 'v1', $4)`,
      [
        accountId,
        user.rows[0]!.id,
        Buffer.from(wrapDataKey(masterKey, dek, 'v1'), 'utf8'),
        Buffer.from(credential, 'utf8'),
      ],
    )
    messageId = randomUUID()
    const enc = (field: 'subject' | 'from' | 'recipients' | 'snippet', value: string) =>
      Buffer.from(encryptField(dek, value, messageFieldAad(field, messageId)), 'utf8')
    await pool.query(
      `INSERT INTO message (id, account_id, message_id_header, subject_enc, from_enc,
         recipients_enc, snippet_enc)
       VALUES ($1, $2, '<restore@example.org>', $3, $4, $5, $6)`,
      [
        messageId,
        accountId,
        enc('subject', 'Restore me'),
        enc('from', 'a@example.org'),
        enc('recipients', '[]'),
        enc('snippet', 'Hello backup'),
      ],
    )
    const ref = path.join(accountId, messageId, 'raw.eml.enc')
    await mkdir(path.join(sourceDir, accountId, messageId), { recursive: true })
    await writeFile(
      path.join(sourceDir, ref),
      encryptBytes(dek, raw, messageFieldAad('body', messageId)),
    )
    await pool.query(`INSERT INTO message_body (message_id, storage_ref) VALUES ($1, $2)`, [
      messageId,
      ref,
    ])
    // A larger file spanning several encryption chunks.
    await mkdir(path.join(sourceDir, 'uploads'), { recursive: true })
    await writeFile(path.join(sourceDir, 'uploads', 'big.enc'), bigFile)

    await backup(backupFile)
  })

  afterAll(async () => {
    for (const name of createdDbs) {
      await pool.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
    }
    await pool.query(`TRUNCATE ${TABLES} CASCADE`)
    await pool.end()
    await rm(workDir, { recursive: true, force: true })
  })

  it('encrypts the whole backup (no plaintext metadata such as host names)', async () => {
    const content = await readFile(backupFile)
    expect(content.subarray(0, 7).toString('ascii')).toBe('fma.bk1')
    expect(content.includes(Buffer.from('backup-host.test'))).toBe(false)
    expect(content.includes(Buffer.from('backup@example.com'))).toBe(false)
    expect(content.includes(Buffer.from(accountId))).toBe(false)
    expect(content.includes(Buffer.from('PGDMP'))).toBe(false)
  })

  it('restores into a fresh database and directory with identical, decryptable data', async () => {
    const target = await freshDatabase()
    const targetDir = path.join(workDir, 'restored')
    const summary = await restore(backupFile, target, targetDir)
    expect(summary.files).toBe(2)
    expect(summary.header.migrations).toEqual(migrations.map((m) => m.name))

    const restored = new pg.Pool({ ...target, max: 1 })
    try {
      const context = await loadAccountContext(restored, accountId, MASTER_KEY)
      expect(context.imap.host).toBe('imap.backup-host.test')
      expect(context.imap.password).toBe('backup-secret')

      const { rows } = await restored.query<{ subject_enc: Buffer; storage_ref: string }>(
        `SELECT m.subject_enc, mb.storage_ref FROM message m
         JOIN message_body mb ON mb.message_id = m.id WHERE m.id = $1`,
        [messageId],
      )
      expect(
        decryptField(
          context.dek,
          rows[0]!.subject_enc.toString('utf8'),
          messageFieldAad('subject', messageId),
        ),
      ).toBe('Restore me')

      const restoredRaw = await readFile(path.join(targetDir, rows[0]!.storage_ref))
      expect(restoredRaw).toEqual(await readFile(path.join(sourceDir, rows[0]!.storage_ref)))
      expect(decryptBytes(context.dek, restoredRaw, messageFieldAad('body', messageId))).toEqual(
        raw,
      )
      expect(await readFile(path.join(targetDir, 'uploads', 'big.enc'))).toEqual(bigFile)

      const applied = await restored.query<{ name: string }>(
        'SELECT name FROM schema_migrations ORDER BY name',
      )
      expect(applied.rows.map((r) => r.name)).toEqual(migrations.map((m) => m.name))
    } finally {
      await restored.end()
    }

    // A second restore into the now filled target is refused without --force ...
    await expect(restore(backupFile, target, targetDir)).rejects.toThrow(/not empty/)
    // ... and replaces everything with it.
    await writeFile(path.join(targetDir, 'stray.enc'), 'x')
    await restore(backupFile, target, targetDir, { force: true })
    expect((await readdir(targetDir)).sort()).toEqual([accountId, 'uploads'].sort())
  })

  it('verifies a backup without touching database or files', async () => {
    const summary = await restore(backupFile, source, path.join(workDir, 'never'), {
      verifyOnly: true,
    })
    expect(summary.files).toBe(2)
    await expect(readdir(path.join(workDir, 'never'))).rejects.toThrow()
  })

  it('fails cleanly with a wrong master key and leaves the target empty', async () => {
    const target = await freshDatabase()
    const targetDir = path.join(workDir, 'wrong-key')
    const error = await restore(backupFile, target, targetDir, { masterKey: WRONG_KEY }).catch(
      (err: unknown) => err,
    )
    expect(error).toBeInstanceOf(BackupDecryptError)
    expect(String(error)).not.toContain(WRONG_KEY)
    expect(await tableCount(target)).toBe(0)
    expect(await readdir(targetDir)).toEqual([])
  })

  it('rejects truncated and modified backups', async () => {
    const content = await readFile(backupFile)
    const truncated = path.join(workDir, 'truncated.fmabk')
    await writeFile(truncated, content.subarray(0, content.length - 100))
    await expect(
      restore(truncated, source, path.join(workDir, 'x'), { verifyOnly: true }),
    ).rejects.toBeInstanceOf(BackupDecryptError)
  })

  it('refuses backups from a newer app version', async () => {
    await pool.query(`INSERT INTO schema_migrations (name) VALUES ('9999_from_the_future')`)
    const future = path.join(workDir, 'future.fmabk')
    try {
      await backup(future)
    } finally {
      await pool.query(`DELETE FROM schema_migrations WHERE name = '9999_from_the_future'`)
    }
    const target = await freshDatabase()
    await expect(restore(future, target, path.join(workDir, 'future'))).rejects.toThrow(BackupError)
    expect(await tableCount(target)).toBe(0)
  })
})
