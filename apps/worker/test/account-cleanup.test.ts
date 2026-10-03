/**
 * Tests for the account_cleanup job (roadmap 3.1): the encrypted files of a
 * deleted account are removed from the mail-data volume, nothing else.
 * Requires DATABASE_URL.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { runMigrations } from '@fma/db/migrate'
import { runAccountCleanup } from '../src/jobs/account-cleanup'

const databaseUrl = process.env.DATABASE_URL

describe.skipIf(!databaseUrl)('account_cleanup job', () => {
  let pool: pg.Pool
  let dataDir: string
  let userId: string

  async function writeMessageFile(accountId: string): Promise<void> {
    const dir = path.join(dataDir, accountId, randomUUID())
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'raw.eml.enc'), 'fma.f1.ciphertext')
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl })
    await runMigrations(pool)
    await pool.query('TRUNCATE "user", mail_account, job CASCADE')
    const user = await pool.query<{ id: string }>(
      `INSERT INTO "user" (email, password_hash) VALUES ($1, 'x') RETURNING id`,
      [`cleanup-${Date.now()}@example.com`],
    )
    userId = user.rows[0]!.id
    dataDir = await mkdtemp(path.join(tmpdir(), 'fma-cleanup-'))
    process.env.MAIL_DATA_DIR = dataDir
  })

  afterAll(async () => {
    await pool.query('TRUNCATE "user", mail_account, job CASCADE')
    await pool.end()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('removes the files of a deleted account and schedules a second pass', async () => {
    const deleted = randomUUID()
    const other = randomUUID()
    await writeMessageFile(deleted)
    await writeMessageFile(deleted)
    await writeMessageFile(other)

    expect(await runAccountCleanup(pool, { accountId: deleted })).toBe('removed')
    expect(await readdir(dataDir)).toEqual([other])

    const { rows } = await pool.query<{ payload: unknown; delayed: boolean }>(
      `SELECT payload, run_at > now() + interval '1 hour' AS delayed
       FROM job WHERE type = 'account_cleanup'`,
    )
    expect(rows).toEqual([{ payload: { accountId: deleted, pass: 2 }, delayed: true }])

    // Second pass: late files are removed, no further pass.
    await writeMessageFile(deleted)
    expect(await runAccountCleanup(pool, { accountId: deleted, pass: 2 })).toBe('removed')
    expect(await readdir(dataDir)).toEqual([other])
    const jobs = await pool.query(`SELECT 1 FROM job WHERE type = 'account_cleanup'`)
    expect(jobs.rowCount).toBe(1)
  })

  it('never touches the files of an existing account', async () => {
    const id = randomUUID()
    await pool.query(
      `INSERT INTO mail_account
         (id, user_id, display_name, email_address, imap_host, imap_port,
          smtp_host, smtp_port, wrapped_dek, key_id, credential_enc)
       VALUES ($1, $2, 'Keep', 'keep@example.com', 'imap.test', 993,
         'smtp.test', 465, '\\x00', 'v1', '\\x00')`,
      [id, userId],
    )
    await writeMessageFile(id)
    expect(await runAccountCleanup(pool, { accountId: id })).toBe('account_exists')
    expect(await readdir(dataDir)).toContain(id)
  })

  it('rejects ids that are not uuids (no path traversal)', async () => {
    expect(await runAccountCleanup(pool, { accountId: '..' })).toBe('invalid')
    expect(await runAccountCleanup(pool, { accountId: '../etc' })).toBe('invalid')
    expect(await runAccountCleanup(pool, {})).toBe('invalid')
  })
})
