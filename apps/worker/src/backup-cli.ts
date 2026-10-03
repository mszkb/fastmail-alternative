/**
 * CLI for encrypted backups (roadmap 6.2, docs/operations/backup-restore.md).
 *
 *   node dist/backup.js create [file|dir]       (default dir: $BACKUP_DIR or /backups)
 *   node dist/backup.js verify <file>
 *   node dist/backup.js restore <file> [--force]
 *
 * Reads MASTER_KEY, MAIL_DATA_DIR and DATABASE_URL / POSTGRES_* from the
 * environment (same as the worker). Prints only counts, sizes and the backup
 * file name - never keys, paths inside mail-data or contents.
 */
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { BackupDecryptError } from '@fma/crypto'
import {
  BackupError,
  createBackup,
  fileSize,
  pgTargetFromEnv,
  restoreBackup,
  type BackupSummary,
} from './backup'

function usage(): never {
  console.error(
    'usage: backup create [file|dir] | backup verify <file> | backup restore <file> [--force]',
  )
  process.exit(2)
}

function timestamp(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
}

function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

function describe(summary: BackupSummary): string {
  return `${summary.files} files, ${mib(summary.bytes)} payload, ${summary.header.migrations.length} migrations, created ${summary.header.createdAt}`
}

async function outputPath(arg: string | undefined): Promise<string> {
  const target = arg ?? process.env.BACKUP_DIR ?? '/backups'
  const isDir = arg === undefined || (await stat(target).catch(() => null))?.isDirectory()
  if (!isDir) return path.resolve(target)
  await mkdir(target, { recursive: true })
  return path.resolve(target, `fma-backup-${timestamp()}.fmabk`)
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)
  const force = rest.includes('--force')
  const args = rest.filter((arg) => !arg.startsWith('--'))
  const masterKey = process.env.MASTER_KEY
  if (!masterKey) throw new BackupError('MASTER_KEY is not set')
  const common = {
    db: pgTargetFromEnv(),
    mailDataDir: process.env.MAIL_DATA_DIR ?? '/app/mail-data',
    masterKey,
  }

  if (command === 'create') {
    const file = await outputPath(args[0])
    const partial = `${file}.partial`
    try {
      const summary = await createBackup({
        ...common,
        output: createWriteStream(partial, { flags: 'wx', mode: 0o600 }),
      })
      await rename(partial, file)
      console.log(`backup written: ${path.basename(file)} (${mib(await fileSize(file))})`)
      console.log(describe(summary))
    } catch (err) {
      await rm(partial, { force: true })
      throw err
    }
    return
  }

  if (command === 'verify' || command === 'restore') {
    const file = args[0]
    if (!file) usage()
    const summary = await restoreBackup({
      ...common,
      input: createReadStream(file),
      force,
      verifyOnly: command === 'verify',
    })
    console.log(`${command === 'verify' ? 'backup ok' : 'restore complete'}: ${describe(summary)}`)
    return
  }

  usage()
}

main().catch((err: unknown) => {
  // Our own errors carry no secrets or contents; anything else is reduced to its type.
  const known = err instanceof BackupError || err instanceof BackupDecryptError
  const code = (err as NodeJS.ErrnoException | null)?.code
  console.error(
    `backup failed: ${known ? (err as Error).message : `${(err as Error)?.name ?? 'Error'}${code ? ` (${code})` : ''}`}`,
  )
  process.exit(1)
})
