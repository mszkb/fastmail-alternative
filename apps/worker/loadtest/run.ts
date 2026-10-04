/**
 * Load test harness (roadmap 6.6, docs/operations/load-test.md).
 *
 * Not part of `pnpm test`; run with `pnpm loadtest`. Fills an IMAP server
 * (GreenMail in development) with LOADTEST_MESSAGES messages, creates
 * LOADTEST_ACCOUNTS accounts in a fresh database (all pointing at the same
 * IMAP user - GreenMail users are fixed at startup), runs the real worker
 * code (JobRunner in-process) until the initial sync and, with
 * LOADTEST_FULL=1, the complete history (load-older windows) is stored,
 * then measures the main API endpoints via Fastify inject.
 *
 * Prints a Markdown report to stdout. Contains no mail contents (the test
 * messages are synthetic anyway).
 *
 * Environment:
 *   LOADTEST_ACCOUNTS (3), LOADTEST_MESSAGES (5000), LOADTEST_FULL (1),
 *   LOADTEST_REQUESTS (30, per endpoint), LOADTEST_DB (mail_loadtest),
 *   LOADTEST_FOLDER (INBOX), LOADTEST_KEEP_MAIL (0: appended messages are
 *   deleted again at the end), DATABASE_URL (admin connection, used to
 *   recreate LOADTEST_DB), GREENMAIL_HOST/_IMAP_PORT/_USER/_PASSWORD.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { ImapFlow } from 'imapflow'
import pg from 'pg'

const env = process.env
const ACCOUNTS = Number(env.LOADTEST_ACCOUNTS ?? 3)
const MESSAGES = Number(env.LOADTEST_MESSAGES ?? 5000)
const FULL = (env.LOADTEST_FULL ?? '1') === '1'
const REQUESTS = Number(env.LOADTEST_REQUESTS ?? 30)
const DB_NAME = env.LOADTEST_DB ?? 'mail_loadtest'
const FOLDER = env.LOADTEST_FOLDER ?? 'INBOX'
const KEEP_MAIL = env.LOADTEST_KEEP_MAIL === '1'
const IMAP_HOST = env.GREENMAIL_HOST ?? '127.0.0.1'
const IMAP_PORT = Number(env.GREENMAIL_IMAP_PORT ?? 3143)
const IMAP_USER = env.GREENMAIL_USER ?? 'testuser@example.com'
const IMAP_PASSWORD = env.GREENMAIL_PASSWORD ?? 'secret123'

if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required')
if (!/^[a-z_][a-z0-9_]*$/.test(DB_NAME)) throw new Error('invalid LOADTEST_DB')

// --- resource sampling ------------------------------------------------------

let peakRss = 0
const sampler = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss)
}, 50)
sampler.unref()
const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1)

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!
}

// --- 1. fill the IMAP server ------------------------------------------------

function syntheticMessage(i: number): string {
  const date = new Date(Date.UTC(2020, 0, 1) + i * 3_600_000).toUTCString()
  const body = `Synthetic load test message ${i}.\r\n`.repeat(20)
  return [
    `From: Sender ${i % 97} <sender${i % 97}@example.com>`,
    `To: ${IMAP_USER}`,
    `Subject: loadtest message ${i} topic${i % 50}`,
    `Date: ${date}`,
    `Message-ID: <loadtest-${i}-${randomUUID()}@example.com>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].join('\r\n')
}

async function imapClient(): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: false,
    auth: { user: IMAP_USER, pass: IMAP_PASSWORD },
    logger: false,
  })
  await client.connect()
  return client
}

/** Appends MESSAGES messages; returns the first appended UID. */
async function fillMailbox(): Promise<number> {
  const client = await imapClient()
  try {
    if (FOLDER.toUpperCase() !== 'INBOX') {
      await client.mailboxCreate(FOLDER).catch(() => undefined)
    }
    const status = await client.status(FOLDER, { uidNext: true })
    if (!status) throw new Error('STATUS failed')
    const firstUid = Number(status.uidNext ?? 1)
    const batch = 50
    for (let i = 0; i < MESSAGES; i += batch) {
      const appends: Promise<unknown>[] = []
      for (let j = i; j < Math.min(MESSAGES, i + batch); j++) {
        appends.push(client.append(FOLDER, syntheticMessage(j), ['\\Seen']))
      }
      await Promise.all(appends)
    }
    return firstUid
  } finally {
    await client.logout()
  }
}

async function removeAppended(firstUid: number): Promise<void> {
  const client = await imapClient()
  try {
    if (FOLDER.toUpperCase() !== 'INBOX') {
      await client.mailboxDelete(FOLDER)
      return
    }
    const lock = await client.getMailboxLock(FOLDER)
    try {
      // In chunks: one huge STORE/EXPUNGE runs into the socket timeout.
      for (let uid = firstUid; uid < firstUid + MESSAGES; uid += 500) {
        await client.messageDelete(`${uid}:${uid + 499}`, { uid: true })
      }
    } finally {
      lock.release()
    }
  } finally {
    await client.logout()
  }
}

// --- 2. fresh database --------------------------------------------------------

async function recreateDatabase(): Promise<string> {
  const admin = new pg.Client({ connectionString: env.DATABASE_URL })
  await admin.connect()
  await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`)
  await admin.query(`CREATE DATABASE ${DB_NAME}`)
  await admin.end()
  const url = new URL(env.DATABASE_URL!)
  url.pathname = `/${DB_NAME}`
  return url.toString()
}

// --- main ---------------------------------------------------------------------

async function main(): Promise<void> {
  const report: string[] = []
  const t0 = performance.now()
  const firstUid = await fillMailbox()
  const fillSeconds = (performance.now() - t0) / 1000

  // The app modules read their configuration on import: set it first.
  env.DATABASE_URL = await recreateDatabase()
  env.MASTER_KEY ??= randomBytes(32).toString('base64')
  env.LOG_LEVEL ??= 'warn'
  env.SETUP_TOKEN = 'loadtest-setup-code'
  env.MAIL_INSECURE_TRANSPORT ??= '1'
  env.MAIL_ALLOW_PRIVATE_HOSTS ??= '1'
  const dataDir = await mkdtemp(path.join(tmpdir(), 'fma-loadtest-'))
  env.MAIL_DATA_DIR = dataDir

  const { runMigrations } = await import('@fma/db/migrate')
  const { enqueueJob } = await import('@fma/db/job-queue')
  const crypto = await import('@fma/crypto')
  const { JobRunner } = await import('../src/runner')
  const { buildApp } = await import('../../api/src/app')
  const { pool: apiPool } = await import('../../api/src/db')

  const pool = new pg.Pool({ connectionString: env.DATABASE_URL })
  let runner: InstanceType<typeof JobRunner> | undefined
  try {
    await runMigrations(pool)
    const app = buildApp({ logger: false, rateLimits: [] })
    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        setupCode: env.SETUP_TOKEN,
        email: 'loadtest@example.com',
        password: 'loadtest password 123',
      }),
    })
    const token = setup.cookies.find((c) => c.name === 'fma_session')?.value
    if (!token) throw new Error(`setup failed (${setup.statusCode})`)
    const { rows: users } = await pool.query<{ id: string }>('SELECT id FROM "user"')
    const userId = users[0]!.id
    await pool.query('UPDATE "user" SET unified_inbox_enabled = true WHERE id = $1', [userId])

    const accountIds: string[] = []
    const master = crypto.loadMasterKey(env.MASTER_KEY)
    for (let i = 0; i < ACCOUNTS; i++) {
      const id = randomUUID()
      const dek = crypto.generateDataKey()
      const credential = Buffer.from(
        crypto.encryptField(
          dek,
          JSON.stringify({ imapUser: IMAP_USER, imapPassword: IMAP_PASSWORD }),
          `mail_account.credential:${id}`,
        ),
        'utf8',
      )
      await pool.query(
        `INSERT INTO mail_account
           (id, user_id, display_name, email_address, imap_host, imap_port,
            smtp_host, smtp_port, wrapped_dek, key_id, credential_enc, status)
         VALUES ($1, $2, $3, $4, $5, $6, $5, 3025, $7, 'v1', $8, 'ok')`,
        [
          id,
          userId,
          `Load ${i}`,
          `load${i}@example.com`,
          IMAP_HOST,
          IMAP_PORT,
          crypto.wrapDataKey(master, dek, 'v1'),
          credential,
        ],
      )
      accountIds.push(id)
    }

    // --- sync with the real worker code ---
    runner = new JobRunner(pool)
    const jobCount = async () =>
      Number(
        (await pool.query<{ n: string }>(`SELECT count(*) AS n FROM job WHERE state = 'done'`))
          .rows[0]!.n,
      )
    const failedJobs = async () =>
      Number(
        (
          await pool.query<{ n: string }>(
            `SELECT count(*) AS n FROM job WHERE state IN ('failed', 'dead') OR attempts > 1`,
          )
        ).rows[0]!.n,
      )
    const messageCount = async () =>
      Number((await pool.query<{ n: string }>('SELECT count(*) AS n FROM message')).rows[0]!.n)

    const runUntilIdle = async () => {
      for (;;) {
        await runner!.fill()
        if (runner!.active === 0) break
        await runner!.waitForSlot(200)
      }
    }

    const rssBefore = process.memoryUsage().rss
    peakRss = rssBefore
    const tSync = performance.now()
    for (const id of accountIds) await enqueueJob(pool, { type: 'folder_sync', accountId: id })
    await runUntilIdle()
    const initialSeconds = (performance.now() - tSync) / 1000
    const initialJobs = await jobCount()
    const initialMessages = await messageCount()
    const initialPeak = peakRss

    let fullSeconds = 0
    let fullJobs = 0
    let fullMessages = initialMessages
    if (FULL) {
      const tFull = performance.now()
      const { rows: folders } = await pool.query<{ id: string; account_id: string }>(
        `SELECT id, account_id FROM folder WHERE upper(path) = upper($1)`,
        [FOLDER],
      )
      let previous = -1
      while (fullMessages !== previous) {
        previous = fullMessages
        for (const folder of folders) {
          await enqueueJob(pool, {
            type: 'message_sync',
            accountId: folder.account_id,
            payload: { folderId: folder.id, loadOlder: true },
          })
        }
        await runUntilIdle()
        fullMessages = await messageCount()
      }
      fullSeconds = (performance.now() - tFull) / 1000
      fullJobs = (await jobCount()) - initialJobs
    }
    const syncPeak = peakRss

    // Incremental run without changes (the regular sync interval).
    const tInc = performance.now()
    for (const id of accountIds) await enqueueJob(pool, { type: 'folder_sync', accountId: id })
    await runUntilIdle()
    const incrementalSeconds = (performance.now() - tInc) / 1000

    const { rows: sizeRows } = await pool.query<{ db: string; msg: string; loc: string }>(
      `SELECT pg_database_size(current_database()) AS db,
              pg_total_relation_size('message') AS msg,
              pg_total_relation_size('message_location') AS loc`,
    )

    // --- API latency ---
    const { rows: inbox } = await pool.query<{ id: string; account_id: string }>(
      `SELECT id, account_id FROM folder WHERE account_id = $1 AND upper(path) = upper($2)`,
      [accountIds[0], FOLDER],
    )
    const folderId = inbox[0]!.id
    const get = (url: string) =>
      app.inject({ method: 'GET', url, headers: { cookie: `fma_session=${token}` } })
    const firstPage = await get(`/api/folders/${folderId}/messages?limit=50`)
    const cursor = firstPage.json<{ nextCursor?: string }>().nextCursor
    const endpoints: [string, string][] = [
      ['Nachrichtenliste (50)', `/api/folders/${folderId}/messages?limit=50`],
      [
        'Nachrichtenliste, Seite 2',
        `/api/folders/${folderId}/messages?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      ],
      ['Unified Inbox (50)', '/api/unified/inbox?limit=50'],
      ['Suche (IMAP SEARCH)', `/api/accounts/${accountIds[0]}/search?q=topic7`],
      ['Speicher gesamt', '/api/storage'],
      ['Ordnerbaum', `/api/accounts/${accountIds[0]}/folders`],
    ]
    const latencyRows: string[] = []
    for (const [name, url] of endpoints) {
      const times: number[] = []
      let status = 0
      for (let i = 0; i < REQUESTS; i++) {
        const start = performance.now()
        const res = await get(url)
        times.push(performance.now() - start)
        status = res.statusCode
      }
      times.sort((a, b) => a - b)
      latencyRows.push(
        `| ${name} | ${status} | ${percentile(times, 50).toFixed(1)} | ${percentile(times, 95).toFixed(1)} | ${times[times.length - 1]!.toFixed(1)} |`,
      )
    }
    const failed = await failedJobs()
    await app.close()

    const totalJobs = await jobCount()
    report.push(
      '# Lasttest-Ergebnis',
      '',
      `- Datum: ${new Date().toISOString()}`,
      `- Node ${process.version}, ${process.platform}/${process.arch}`,
      `- Konten: ${ACCOUNTS}, Nachrichten pro Postfach: ${MESSAGES}, Ordner: ${FOLDER}, ` +
        `volle Historie: ${FULL ? 'ja' : 'nein'}`,
      `- WORKER_CONCURRENCY=${env.WORKER_CONCURRENCY ?? '4 (Standard)'}, ` +
        `IMAP_MAX_CONNECTIONS_PER_HOST=${env.IMAP_MAX_CONNECTIONS_PER_HOST ?? 'Standard'}`,
      '',
      '## Sync',
      '',
      '| Messgröße | Wert |',
      '| --- | --- |',
      `| Befüllen per IMAP APPEND | ${fillSeconds.toFixed(1)} s (${(MESSAGES / fillSeconds).toFixed(0)} Mails/s) |`,
      `| Initial-Sync (folder_sync + erstes Fenster) | ${initialSeconds.toFixed(1)} s, ${initialMessages} Nachrichten, ${initialJobs} Jobs |`,
      `| Volle Historie (load older) | ${fullSeconds.toFixed(1)} s, ${fullMessages} Nachrichten, ${fullJobs} Jobs (${fullSeconds ? (fullJobs / fullSeconds).toFixed(2) : '-'} Jobs/s, ${fullSeconds ? ((fullMessages - initialMessages) / fullSeconds).toFixed(0) : '-'} Mails/s) |`,
      `| Inkrementeller Lauf ohne Änderungen | ${incrementalSeconds.toFixed(2)} s |`,
      `| Jobs gesamt / fehlgeschlagen oder wiederholt | ${totalJobs} / ${failed} |`,
      `| RSS vor Sync | ${mb(rssBefore)} MB |`,
      `| Spitzen-RSS Initial-Sync | ${mb(initialPeak)} MB |`,
      `| Spitzen-RSS gesamt (Sync + API) | ${mb(Math.max(syncPeak, peakRss))} MB |`,
      `| DB-Größe | ${mb(Number(sizeRows[0]!.db))} MB (message ${mb(Number(sizeRows[0]!.msg))} MB, message_location ${mb(Number(sizeRows[0]!.loc))} MB) |`,
      '',
      `## API-Latenz (${REQUESTS} Requests je Endpunkt, Fastify inject, ms)`,
      '',
      '| Endpunkt | Status | p50 | p95 | max |',
      '| --- | --- | --- | --- | --- |',
      ...latencyRows,
      '',
      'Hinweis: API und Worker laufen im selben Prozess; der Spitzen-RSS ist daher eine ' +
        'obere Schranke für jeden der beiden Container.',
    )
    console.log(report.join('\n'))
    await apiPool.end()
  } finally {
    if (runner) await runner.drain()
    await pool.end()
    await rm(dataDir, { recursive: true, force: true })
    if (!KEEP_MAIL) await removeAppended(firstUid)
    clearInterval(sampler)
  }
}

main().catch((err: unknown) => {
  console.error('load test failed:', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
