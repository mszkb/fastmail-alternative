/**
 * Encrypted backup and restore of an instance (roadmap 6.2,
 * docs/operations/backup-restore.md).
 *
 * A backup is one file: the chunked AES-256-GCM stream from @fma/crypto
 * (key derived from MASTER_KEY + per-backup salt) around a simple record
 * stream:
 *
 *   H header   {format, version, createdAt, migrations}
 *   B begin    {kind: 'db'} | {kind: 'file', path}
 *   D data     raw bytes (<= 64 KiB per record)
 *   E end      {size, sha256}
 *   M manifest {entries: [{kind, path?, size, sha256}]}  (after all entries,
 *              split into blocks of MANIFEST_ENTRIES_PER_RECORD entries)
 *   Z trailer  {entries}  total manifest entries (always last)
 *
 * The database entry is a `pg_dump -Fc` stream and comes first, followed by
 * every regular file of the mail-data directory. Everything is streamed:
 * memory use stays bounded by a few chunks (Raspberry Pi).
 *
 * The MASTER_KEY itself is never part of a backup; it must be backed up
 * separately. Nothing here logs file names, paths or contents.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createReadStream, createWriteStream } from 'node:fs'
import { chown, mkdir, readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import pg from 'pg'
import { createBackupDecryptStream, createBackupEncryptStream, loadMasterKey } from '@fma/crypto'
import { migrations as knownMigrations, runMigrations } from '@fma/db/migrate'

export const BACKUP_FORMAT = 'fma-backup'
export const BACKUP_VERSION = 2
const RECORD_DATA_BYTES = 64 * 1024
/** Upper bound for a single record; data records are far smaller. */
const MAX_RECORD_BYTES = 16 * 1024 * 1024
/** Manifest entries per M record (~200 bytes each: well below MAX_RECORD_BYTES). */
const MANIFEST_ENTRIES_PER_RECORD = 1000
/** Placeholder root for path validation when only verifying. */
const VERIFY_ROOT = path.resolve('/fma-verify')

/** Connection parameters for PostgreSQL and the pg_dump/pg_restore tools. */
export interface PgTarget {
  host: string
  port: number
  user: string
  password?: string
  database: string
}

export interface BackupHeader {
  format: typeof BACKUP_FORMAT
  version: number
  createdAt: string
  /** Applied schema migrations of the backed-up database. */
  migrations: string[]
}

export interface ManifestEntry {
  kind: 'db' | 'file'
  path?: string
  size: number
  sha256: string
}

export interface BackupSummary {
  header: BackupHeader
  files: number
  bytes: number
}

/** Thrown for problems the operator has to resolve (not-empty target, version...). */
export class BackupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BackupError'
  }
}

/** PgTarget from DATABASE_URL or the POSTGRES_* variables (same as createPool). */
export function pgTargetFromEnv(env: NodeJS.ProcessEnv = process.env): PgTarget {
  if (env.DATABASE_URL) {
    const url = new URL(env.DATABASE_URL)
    return {
      host: url.hostname,
      port: Number.parseInt(url.port || '5432', 10),
      user: decodeURIComponent(url.username),
      password: url.password ? decodeURIComponent(url.password) : undefined,
      database: decodeURIComponent(url.pathname.replace(/^\//, '')),
    }
  }
  return {
    host: env.POSTGRES_HOST ?? 'localhost',
    port: Number.parseInt(env.POSTGRES_PORT ?? '5432', 10),
    user: env.POSTGRES_USER ?? 'mail',
    password: env.POSTGRES_PASSWORD,
    database: env.POSTGRES_DB ?? 'mail',
  }
}

function pgPool(target: PgTarget): pg.Pool {
  return new pg.Pool({ ...target, max: 1 })
}

/**
 * Number of outbox messages not yet accepted by SMTP (queued/sending). After
 * a restore these may already have been sent after the backup was taken -
 * starting the worker would send them again (docs/operations/upgrade.md).
 */
export async function pendingOutboxCount(target: PgTarget): Promise<number> {
  const pool = pgPool(target)
  try {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM outbox_message
       WHERE sent_at IS NULL AND status IN ('queued', 'sending')`,
    )
    return rows[0]?.n ?? 0
  } finally {
    await pool.end()
  }
}

/** Environment for pg_dump/pg_restore: credentials never on the command line. */
function pgToolEnv(target: PgTarget): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    PGHOST: target.host,
    PGPORT: String(target.port),
    PGUSER: target.user,
    PGDATABASE: target.database,
  }
  if (target.password) env.PGPASSWORD = target.password
  return env
}

function pgTool(name: 'pg_dump' | 'pg_restore'): string {
  return process.env.PG_BIN ? path.join(process.env.PG_BIN, name) : name
}

/** Spawns a pg tool and collects only its `error:` line (no SQL/data echoes). */
function spawnPgTool(
  name: 'pg_dump' | 'pg_restore',
  args: string[],
  target: PgTarget,
  stdio: 'stdin' | 'stdout',
): { child: ChildProcess; done: Promise<void> } {
  const child = spawn(pgTool(name), args, {
    env: pgToolEnv(target),
    stdio: stdio === 'stdout' ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'ignore', 'pipe'],
  })
  let errorLine = ''
  child.stderr!.setEncoding('utf8')
  child.stderr!.on('data', (text: string) => {
    if (errorLine) return
    const line = text.split('\n').find((l) => l.includes('error:'))
    if (line) errorLine = line.slice(0, 200)
  })
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', (err) =>
      reject(new BackupError(`${name} could not be started: ${err.message}`)),
    )
    child.once('close', (code) => {
      if (code === 0) resolve()
      else
        reject(new BackupError(`${name} failed (exit ${code})${errorLine ? `: ${errorLine}` : ''}`))
    })
  })
  // Avoid unhandled rejections while the stream side is still running.
  done.catch(() => {})
  return { child, done }
}

async function appliedMigrations(target: PgTarget): Promise<string[]> {
  const pool = pgPool(target)
  try {
    const { rows } = await pool.query<{ name: string }>(
      `SELECT name FROM schema_migrations ORDER BY name`,
    )
    return rows.map((row) => row.name)
  } catch {
    return []
  } finally {
    await pool.end()
  }
}

/** Regular files below `root` as relative POSIX paths, sorted; streams the walk. */
async function* listFiles(root: string, relative = ''): AsyncGenerator<string> {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true }).catch(
    (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT' && relative === '') return []
      throw err
    },
  )
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const entry of entries) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isDirectory()) yield* listFiles(root, rel)
    else if (entry.isFile()) yield rel
    // Symlinks, sockets etc. are never written by the app: skipped.
  }
}

function record(type: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(5)
  head.write(type, 0, 'ascii')
  head.writeUInt32BE(payload.length, 1)
  return Buffer.concat([head, payload])
}

function jsonRecord(type: string, value: unknown): Buffer {
  return record(type, Buffer.from(JSON.stringify(value), 'utf8'))
}

/** Emits B, D*, E records for one byte stream; pushes its manifest entry. */
async function* entryRecords(
  begin: { kind: 'db' | 'file'; path?: string },
  source: AsyncIterable<Buffer>,
  manifest: ManifestEntry[],
): AsyncGenerator<Buffer> {
  yield jsonRecord('B', begin)
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of source) {
    for (let offset = 0; offset < chunk.length; offset += RECORD_DATA_BYTES) {
      const part = chunk.subarray(offset, offset + RECORD_DATA_BYTES)
      hash.update(part)
      size += part.length
      yield record('D', part)
    }
  }
  const end = { size, sha256: hash.digest('hex') }
  manifest.push({ ...begin, ...end })
  yield jsonRecord('E', end)
}

export interface CreateBackupOptions {
  db: PgTarget
  mailDataDir: string
  /** Base64 MASTER_KEY (same as the running instance). */
  masterKey: string
  output: Writable
  /** Manifest entries per record (tests only; default MANIFEST_ENTRIES_PER_RECORD). */
  manifestEntriesPerRecord?: number
}

/** Writes an encrypted backup of database + mail-data to `output`. */
export async function createBackup(options: CreateBackupOptions): Promise<BackupSummary> {
  const masterKey = loadMasterKey(options.masterKey)
  const header: BackupHeader = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    migrations: await appliedMigrations(options.db),
  }
  const manifest: ManifestEntry[] = []
  const root = path.resolve(options.mailDataDir)
  let files = 0
  let bytes = 0

  async function* records(): AsyncGenerator<Buffer> {
    yield jsonRecord('H', header)

    const dump = spawnPgTool(
      'pg_dump',
      ['--format=custom', '--no-owner', '--no-acl'],
      options.db,
      'stdout',
    )
    yield* entryRecords({ kind: 'db' }, dump.child.stdout as AsyncIterable<Buffer>, manifest)
    await dump.done

    for await (const rel of listFiles(root)) {
      yield* entryRecords(
        { kind: 'file', path: rel },
        createReadStream(path.join(root, rel)),
        manifest,
      )
      files++
    }
    for (const entry of manifest) bytes += entry.size
    const perRecord = options.manifestEntriesPerRecord ?? MANIFEST_ENTRIES_PER_RECORD
    for (let i = 0; i < manifest.length; i += perRecord) {
      yield jsonRecord('M', { entries: manifest.slice(i, i + perRecord) })
    }
    yield jsonRecord('Z', { entries: manifest.length })
  }

  await pipeline(records(), createBackupEncryptStream(masterKey), options.output)
  return { header, files, bytes }
}

/** Reads exactly-sized pieces from a byte stream. */
class ByteReader {
  private buffer: Buffer = Buffer.alloc(0)
  private done = false
  constructor(private readonly source: AsyncIterator<Buffer>) {}

  async read(n: number): Promise<Buffer | null> {
    while (this.buffer.length < n && !this.done) {
      const next = await this.source.next()
      if (next.done) this.done = true
      else this.buffer = this.buffer.length ? Buffer.concat([this.buffer, next.value]) : next.value
    }
    if (this.buffer.length === 0 && this.done) return null
    if (this.buffer.length < n) throw new BackupError('backup is truncated')
    const out = this.buffer.subarray(0, n)
    this.buffer = this.buffer.subarray(n)
    return out
  }
}

async function readRecord(reader: ByteReader): Promise<{ type: string; payload: Buffer } | null> {
  const head = await reader.read(5)
  if (!head) return null
  const length = head.readUInt32BE(1)
  if (length > MAX_RECORD_BYTES) throw new BackupError('backup is corrupt (record too large)')
  const payload = length > 0 ? await reader.read(length) : Buffer.alloc(0)
  return { type: head.toString('ascii', 0, 1), payload: payload ?? Buffer.alloc(0) }
}

function parseJson<T>(payload: Buffer): T {
  try {
    return JSON.parse(payload.toString('utf8')) as T
  } catch {
    throw new BackupError('backup is corrupt (invalid record)')
  }
}

/** Relative mail-data path from a backup -> safe absolute path inside root. */
function safeTargetPath(root: string, rel: unknown): string {
  if (typeof rel !== 'string' || rel === '' || rel.includes('\0') || rel.includes('\\')) {
    throw new BackupError('backup is corrupt (invalid file path)')
  }
  const target = path.resolve(root, rel)
  if (
    !target.startsWith(root + path.sep) ||
    path.isAbsolute(rel) ||
    rel.split('/').includes('..')
  ) {
    throw new BackupError('backup is corrupt (invalid file path)')
  }
  return target
}

/** Writes to a child's stdin or a file, honouring backpressure. */
async function writeChunk(sink: Writable, chunk: Buffer): Promise<void> {
  if (!sink.write(chunk)) {
    await Promise.race([
      once(sink, 'drain'),
      once(sink, 'close').then(() => {
        throw new BackupError('restore target closed unexpectedly')
      }),
    ])
  }
}

async function endSink(sink: Writable): Promise<void> {
  sink.end()
  if (!sink.writableFinished) await once(sink, 'finish')
}

export interface RestoreBackupOptions {
  db: PgTarget
  mailDataDir: string
  masterKey: string
  /**
   * Opens the backup for reading. May be called twice: with `force` on a
   * non-empty target the whole backup is verified before anything is deleted.
   */
  openInput: () => Readable
  /** Replace a non-empty database / mail-data directory. */
  force?: boolean
  /** Only decrypt and check checksums; touches neither database nor files. */
  verifyOnly?: boolean
  /** uid:gid for restored files when running as root (default: the worker user 1000:1000). */
  owner?: { uid: number; gid: number }
}

async function databaseIsEmpty(pool: pg.Pool): Promise<boolean> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S')`,
  )
  return rows[0]?.n === '0'
}

async function directoryIsEmpty(dir: string): Promise<boolean> {
  const entries = await readdir(dir).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return []
    throw err
  })
  return entries.length === 0
}

/**
 * Restores a backup into an empty database and an empty mail-data directory
 * (or replaces both with `force`), verifies all checksums and runs pending
 * migrations afterwards. With `verifyOnly` it only checks the backup.
 *
 * With `force` on a non-empty target the complete backup is verified first
 * (key, header, version, migrations, checksums, manifest); existing data is
 * only deleted once that check has passed.
 */
export async function restoreBackup(options: RestoreBackupOptions): Promise<BackupSummary> {
  const masterKey = loadMasterKey(options.masterKey)
  const root = path.resolve(options.mailDataDir)
  if (options.verifyOnly) return readBackup(options.openInput(), masterKey, null)

  const owner =
    typeof process.getuid === 'function' && process.getuid() === 0
      ? (options.owner ?? { uid: 1000, gid: 1000 })
      : null

  const pool = pgPool(options.db)
  try {
    const dbEmpty = await databaseIsEmpty(pool)
    const dirEmpty = await directoryIsEmpty(root)
    if ((!dbEmpty || !dirEmpty) && !options.force) {
      throw new BackupError(
        `restore target is not empty (${[!dbEmpty && 'database', !dirEmpty && 'mail-data'].filter(Boolean).join(' and ')}); use --force to replace it`,
      )
    }
    if (!dbEmpty || !dirEmpty) {
      // Full verification pass before anything is deleted: a wrong key, a
      // backup from a newer version or a damaged file must not cost the
      // existing data.
      await readBackup(options.openInput(), masterKey, null)
    }
    if (!dbEmpty) {
      await pool.query('DROP SCHEMA public CASCADE')
      await pool.query('CREATE SCHEMA public')
    }
    if (!dirEmpty) {
      for (const entry of await readdir(root)) {
        await rm(path.join(root, entry), { recursive: true, force: true })
      }
    }
    await mkdir(root, { recursive: true })
  } finally {
    await pool.end()
  }

  const summary = await readBackup(options.openInput(), masterKey, {
    db: options.db,
    root,
    owner,
  })
  const migratePool = pgPool(options.db)
  try {
    await runMigrations(migratePool)
  } finally {
    await migratePool.end()
  }
  return summary
}

interface RestoreTarget {
  db: PgTarget
  root: string
  owner: { uid: number; gid: number } | null
}

/**
 * Decrypts and checks a backup; with a `target` it also writes the database
 * and files. Throws on any inconsistency.
 */
async function readBackup(
  input: Readable,
  masterKey: Buffer,
  target: RestoreTarget | null,
): Promise<BackupSummary> {
  let header: BackupHeader | null = null
  const seen: ManifestEntry[] = []
  let manifestCount = 0
  let manifestComplete = false
  let files = 0

  function checkManifestEntry(entry: ManifestEntry): void {
    const expected = seen[manifestCount]
    if (
      !expected ||
      entry.kind !== expected.kind ||
      entry.path !== expected.path ||
      entry.size !== expected.size ||
      entry.sha256 !== expected.sha256
    ) {
      throw new BackupError('backup manifest does not match its contents')
    }
    manifestCount++
  }

  async function consume(source: AsyncIterable<Buffer>): Promise<void> {
    const reader = new ByteReader(source[Symbol.asyncIterator]())
    const first = await readRecord(reader)
    if (!first || first.type !== 'H') throw new BackupError('backup is corrupt (missing header)')
    header = parseJson<BackupHeader>(first.payload)
    if (
      header.format !== BACKUP_FORMAT ||
      header.version !== BACKUP_VERSION ||
      !Array.isArray(header.migrations)
    ) {
      throw new BackupError(`unsupported backup format/version (${String(header.version)})`)
    }
    const known = new Set(knownMigrations.map((m) => m.name))
    if (header.migrations.some((name) => !known.has(name))) {
      throw new BackupError(
        'backup comes from a newer app version (unknown migrations); update the app first',
      )
    }

    for (;;) {
      const rec = await readRecord(reader)
      if (!rec) throw new BackupError('backup is truncated (missing manifest)')
      if (rec.type === 'M') {
        // Manifest: one or more M records, then the Z trailer with the total.
        let current: { type: string; payload: Buffer } | null = rec
        while (current && current.type === 'M') {
          const part = parseJson<{ entries: ManifestEntry[] }>(current.payload)
          if (!Array.isArray(part.entries)) throw new BackupError('backup is corrupt (manifest)')
          for (const entry of part.entries) checkManifestEntry(entry)
          current = await readRecord(reader)
        }
        if (!current || current.type !== 'Z') {
          throw new BackupError('backup is truncated (missing manifest trailer)')
        }
        const trailer = parseJson<{ entries: number }>(current.payload)
        if (trailer.entries !== manifestCount || manifestCount !== seen.length) {
          throw new BackupError('backup manifest does not match its contents')
        }
        if ((await readRecord(reader)) !== null) {
          throw new BackupError('backup is corrupt (data after manifest)')
        }
        manifestComplete = true
        return
      }
      if (rec.type !== 'B') throw new BackupError('backup is corrupt (unexpected record)')
      const begin = parseJson<{ kind: 'db' | 'file'; path?: string }>(rec.payload)

      let sink: Writable | null = null
      let sinkError: Promise<never> | null = null
      let tool: { child: ChildProcess; done: Promise<void> } | null = null
      let filePath: string | null = null
      if (begin.kind === 'db') {
        if (seen.length > 0) throw new BackupError('backup is corrupt (database not first)')
        if (target) {
          tool = spawnPgTool(
            'pg_restore',
            [
              '--no-owner',
              '--no-acl',
              '--exit-on-error',
              '--single-transaction',
              `--dbname=${target.db.database}`,
            ],
            target.db,
            'stdin',
          )
          sink = tool.child.stdin!
          // EPIPE when pg_restore exits early: reported via tool.done.
          sink.on('error', () => {})
        }
      } else if (begin.kind === 'file') {
        filePath = safeTargetPath(target?.root ?? VERIFY_ROOT, begin.path)
        if (target) {
          await mkdir(path.dirname(filePath), { recursive: true })
          const stream = createWriteStream(filePath, { flags: 'wx', mode: 0o600 })
          // Permanent listener: ENOSPC/EACCES reject the restore instead of
          // becoming an uncaught exception.
          sinkError = new Promise<never>((_, reject) => {
            stream.on('error', (err: NodeJS.ErrnoException) =>
              reject(
                new BackupError(
                  `writing a restored file failed${err.code ? ` (${err.code})` : ''}`,
                ),
              ),
            )
          })
          sinkError.catch(() => {})
          sink = stream
        }
      } else {
        throw new BackupError('backup is corrupt (unknown entry)')
      }

      const guard = <T>(work: Promise<T>): Promise<T> =>
        sinkError ? Promise.race([work, sinkError]) : work

      const hash = createHash('sha256')
      let size = 0
      try {
        for (;;) {
          const data = await readRecord(reader)
          if (!data) throw new BackupError('backup is truncated')
          if (data.type === 'D') {
            hash.update(data.payload)
            size += data.payload.length
            if (sink) await guard(writeChunk(sink, data.payload))
            continue
          }
          if (data.type !== 'E') throw new BackupError('backup is corrupt (unexpected record)')
          const end = parseJson<{ size: number; sha256: string }>(data.payload)
          const sha256 = hash.digest('hex')
          if (end.size !== size || end.sha256 !== sha256) {
            throw new BackupError('backup checksum mismatch')
          }
          seen.push({ ...begin, size, sha256 })
          break
        }
        if (sink) await guard(endSink(sink))
        if (tool) await tool.done
      } catch (err) {
        if (tool) tool.child.kill()
        sink?.destroy()
        throw err
      }
      if (begin.kind === 'file') {
        files++
        if (target?.owner && filePath) await chownPath(target.root, filePath, target.owner)
      }
    }
  }

  await pipeline(input, createBackupDecryptStream(masterKey), consume)

  const parsedHeader = header as BackupHeader | null
  if (!parsedHeader || !manifestComplete) throw new BackupError('backup is incomplete')
  if (!seen.some((entry) => entry.kind === 'db')) {
    throw new BackupError('backup contains no database')
  }
  return { header: parsedHeader, files, bytes: seen.reduce((sum, entry) => sum + entry.size, 0) }
}

/** chown the file and its parent dirs up to (excluding) root. */
async function chownPath(root: string, file: string, owner: { uid: number; gid: number }) {
  let current = file
  while (current.startsWith(root + path.sep)) {
    await chown(current, owner.uid, owner.gid)
    current = path.dirname(current)
  }
}

/** Size of a file for the CLI summary (0 if missing). */
export async function fileSize(file: string): Promise<number> {
  return (await stat(file).catch(() => null))?.size ?? 0
}
