/**
 * IMAP IDLE for the INBOX (roadmap 2.2). Per ADR-0003 IDLE is a
 * worker-managed long-lived connection, NOT a queue job: the IdleManager
 * keeps one imapflow connection per active account with the INBOX open in
 * IDLE. Any change the server reports (new mail, expunge, flag change)
 * only enqueues a message_sync job for that INBOX (deduplicated, see
 * enqueueMessageSync); the actual sync stays in the job. The periodic
 * scheduler remains the fallback.
 *
 * - Accounts are reconciled periodically: new accounts get a connection,
 *   deleted/disabled accounts and accounts with auth errors or an open
 *   circuit breaker (next_retry_at) are disconnected.
 * - Per-account isolation: every connection reconnects independently with
 *   exponential backoff and jitter; an auth failure waits the maximum
 *   backoff (the jobs mark the account as auth_error).
 * - Logs only contain account ids and error codes, never provider texts.
 */
import { ImapFlow } from 'imapflow'
import type { Pool } from '@fma/db'
import { loadAccountContext } from './accounts'
import { classifyAccountError } from './account-health'
import { log } from './log'
import { assertMailHost, mailTestMode } from './ports'
import { enqueueMessageSync, syncMinIntervalSeconds } from './scheduler'

const DEFAULT_RECONCILE_MS = 60_000
const DEFAULT_MAX_CONNECTIONS = 50
/** imapflow breaks and restarts IDLE after this time (RFC 2177: < 29 min). */
const IDLE_RESTART_MS = 25 * 60_000
const BACKOFF_BASE_MS = 5_000
const BACKOFF_MAX_MS = 30 * 60_000

/** IMAP_IDLE=0 disables IDLE (polling only). */
export function imapIdleEnabled(): boolean {
  return process.env.IMAP_IDLE !== '0' && process.env.IMAP_IDLE !== 'false'
}

/** Upper bound for concurrent IDLE connections (IMAP_IDLE_MAX_CONNECTIONS). */
export function imapIdleMaxConnections(): number {
  const value = Number(process.env.IMAP_IDLE_MAX_CONNECTIONS)
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_CONNECTIONS
}

/** Backoff with full jitter in [delay/2, delay]. */
export function idleBackoffMs(failures: number, random = Math.random): number {
  const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1))
  return Math.round(delay / 2 + (random() * delay) / 2)
}

/** A connection must stay up this long before its failure count is reset. */
export const IDLE_STABLE_MS = 60_000

/**
 * Failure count after a connection closed: only a connection that was stable
 * for IDLE_STABLE_MS starts over, so a server that accepts and immediately
 * drops connections still backs off exponentially.
 */
export function failuresAfterClose(failures: number, connectedForMs: number): number {
  return (connectedForMs >= IDLE_STABLE_MS ? 0 : failures) + 1
}

function errorCode(err: unknown): string {
  const classified = classifyAccountError(err)
  if (classified) return classified.code
  const error = err as { code?: unknown; name?: unknown } | null
  if (error && typeof error.code === 'string') return error.code
  if (error && typeof error.name === 'string') return error.name
  return 'UNKNOWN'
}

interface IdleConnection {
  accountId: string
  folderId: string
  client: ImapFlow | null
  stopped: boolean
  connected: boolean
  failures: number
  /** Date.now() of the last successful connect (0 while not connected). */
  connectedAt: number
  timer: NodeJS.Timeout | null
}

export interface IdleManagerOptions {
  reconcileMs?: number
  maxConnections?: number
  masterKey?: string
  /** Debounce of IDLE-triggered syncs (default SYNC_MIN_INTERVAL_SECONDS). */
  syncMinIntervalSeconds?: number
}

export class IdleManager {
  private readonly connections = new Map<string, IdleConnection>()
  private reconcileTimer: NodeJS.Timeout | null = null
  private stopped = false
  private readonly reconcileMs: number
  private readonly maxConnections: number
  private readonly masterKey: string
  private readonly syncMinIntervalSeconds: number

  constructor(
    private readonly pool: Pool,
    options: IdleManagerOptions = {},
  ) {
    this.reconcileMs = options.reconcileMs ?? DEFAULT_RECONCILE_MS
    this.maxConnections = options.maxConnections ?? imapIdleMaxConnections()
    this.masterKey = options.masterKey ?? process.env.MASTER_KEY ?? ''
    this.syncMinIntervalSeconds = options.syncMinIntervalSeconds ?? syncMinIntervalSeconds()
  }

  async start(): Promise<void> {
    await this.reconcile()
    this.reconcileTimer = setInterval(() => {
      void this.reconcile()
    }, this.reconcileMs)
    this.reconcileTimer.unref()
  }

  /** Account ids with an established IDLE connection (tests, diagnostics). */
  connectedAccountIds(): string[] {
    return [...this.connections.values()].filter((c) => c.connected).map((c) => c.accountId)
  }

  /** Account ids the manager currently maintains (connected or reconnecting). */
  managedAccountIds(): string[] {
    return [...this.connections.keys()]
  }

  /** Aligns the connections with the active accounts that have an INBOX. */
  async reconcile(): Promise<void> {
    if (this.stopped) return
    let rows: { account_id: string; folder_id: string }[]
    try {
      const result = await this.pool.query<{ account_id: string; folder_id: string }>(
        `SELECT ma.id AS account_id, f.id AS folder_id
         FROM mail_account ma
         JOIN folder f ON f.account_id = ma.id AND upper(f.path) = 'INBOX'
         WHERE ma.status NOT IN ('disabled', 'auth_error')
           AND (ma.next_retry_at IS NULL OR ma.next_retry_at <= now())
           AND f.selectable
         ORDER BY ma.created_at, ma.id
         LIMIT $1`,
        [this.maxConnections],
      )
      rows = result.rows
    } catch (err) {
      log.error({ code: errorCode(err) }, 'idle reconcile failed')
      return
    }
    if (this.stopped) return

    const wanted = new Map(rows.map((row) => [String(row.account_id), String(row.folder_id)]))
    for (const [accountId, connection] of this.connections) {
      if (wanted.get(accountId) !== connection.folderId) {
        this.connections.delete(accountId)
        await this.closeConnection(connection)
        log.info({ accountId }, 'idle stopped for account')
      }
    }
    for (const [accountId, folderId] of wanted) {
      if (this.connections.has(accountId)) continue
      const connection: IdleConnection = {
        accountId,
        folderId,
        client: null,
        stopped: false,
        connected: false,
        failures: 0,
        connectedAt: 0,
        timer: null,
      }
      this.connections.set(accountId, connection)
      void this.connect(connection)
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.reconcileTimer) clearInterval(this.reconcileTimer)
    const all = [...this.connections.values()]
    this.connections.clear()
    await Promise.all(all.map((connection) => this.closeConnection(connection)))
  }

  private async closeConnection(connection: IdleConnection): Promise<void> {
    connection.stopped = true
    connection.connected = false
    if (connection.timer) clearTimeout(connection.timer)
    const client = connection.client
    connection.client = null
    if (!client) return
    try {
      await Promise.race([
        client.logout(),
        new Promise((resolve) => setTimeout(resolve, 3_000).unref()),
      ])
    } catch {
      // ignore: closing anyway
    }
    client.close()
  }

  private scheduleReconnect(connection: IdleConnection, delayMs: number): void {
    if (connection.stopped || this.stopped) return
    if (connection.timer) clearTimeout(connection.timer)
    connection.timer = setTimeout(() => {
      connection.timer = null
      void this.connect(connection)
    }, delayMs)
    connection.timer.unref()
  }

  private enqueue(connection: IdleConnection): void {
    if (connection.stopped) return
    enqueueMessageSync(
      this.pool,
      connection.accountId,
      connection.folderId,
      this.syncMinIntervalSeconds,
    ).catch((err) => {
      log.error({ accountId: connection.accountId, code: errorCode(err) }, 'idle enqueue failed')
    })
  }

  private async connect(connection: IdleConnection): Promise<void> {
    if (connection.stopped || this.stopped) return
    const { accountId } = connection
    let client: ImapFlow | null = null
    try {
      const { imap } = await loadAccountContext(this.pool, accountId, this.masterKey)
      await assertMailHost(imap.host)
      if (connection.stopped) return
      client = new ImapFlow({
        host: imap.host,
        port: imap.port,
        secure: imap.secure,
        auth: { user: imap.user, pass: imap.password },
        logger: false,
        greetingTimeout: 15_000,
        maxIdleTime: IDLE_RESTART_MS,
        tls: mailTestMode() ? { rejectUnauthorized: false } : undefined,
        ...(mailTestMode() ? { doSTARTTLS: false as const } : {}),
      })
      connection.client = client
      // Errors surface via 'close' (reconnect); never log provider texts.
      client.on('error', (err: unknown) => {
        log.warn({ accountId, code: errorCode(err) }, 'idle connection error')
      })
      client.on('exists', () => this.enqueue(connection))
      client.on('expunge', () => this.enqueue(connection))
      client.on('flags', () => this.enqueue(connection))
      const ownClient = client
      client.on('close', () => {
        if (connection.client !== ownClient || connection.stopped) return
        connection.client = null
        connection.connected = false
        connection.failures = failuresAfterClose(
          connection.failures,
          connection.connectedAt ? Date.now() - connection.connectedAt : 0,
        )
        connection.connectedAt = 0
        log.info({ accountId }, 'idle connection closed, reconnecting')
        this.scheduleReconnect(connection, idleBackoffMs(connection.failures))
      })

      await client.connect()
      await client.mailboxOpen('INBOX', { readOnly: true })
      if (connection.stopped) {
        client.close()
        return
      }
      // After a reconnect, changes during the gap are picked up by a sync.
      if (connection.failures > 0) this.enqueue(connection)
      // failures is reset only once the connection proved stable (see 'close').
      connection.connected = true
      connection.connectedAt = Date.now()
      log.info({ accountId }, 'idle connected')
      // Enter IDLE now (imapflow's auto-IDLE would wait 15 s); imapflow
      // restarts it every maxIdleTime and re-enters it after other commands.
      client.idle().catch(() => {
        // connection errors surface via 'close'
      })
    } catch (err) {
      if (client) {
        if (connection.client === client) connection.client = null
        client.close()
      }
      if (connection.stopped) return
      connection.failures += 1
      const classified = classifyAccountError(err)
      const delay =
        classified?.kind === 'auth' ? BACKOFF_MAX_MS : idleBackoffMs(connection.failures)
      log.warn({ accountId, code: errorCode(err), retryInMs: delay }, 'idle connect failed')
      this.scheduleReconnect(connection, delay)
    }
  }
}
