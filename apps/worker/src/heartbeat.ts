/**
 * Worker liveness heartbeat for the Docker healthcheck (roadmap 1.3).
 *
 * The worker has no HTTP port. Instead its main loop writes the current
 * Unix timestamp (milliseconds) to a file after a successful database
 * round trip (`SELECT 1`), at most every HEARTBEAT_INTERVAL_MS. The
 * healthcheck (./healthcheck, dist/healthcheck.js) only checks that the
 * file is fresh, so "healthy" means: the main loop is not stuck and the
 * database is reachable.
 *
 * This module has no runtime dependencies (no pino, no pg) so the
 * healthcheck bundle stays tiny and starts fast.
 */
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'

export const DEFAULT_HEARTBEAT_FILE = '/tmp/worker-heartbeat'
/** How often the main loop writes the heartbeat. */
export const HEARTBEAT_INTERVAL_MS = 30_000
/** Older heartbeats count as unhealthy (several missed intervals). */
export const HEARTBEAT_MAX_AGE_MS = 120_000

/** Heartbeat file path from WORKER_HEARTBEAT_FILE (default /tmp/worker-heartbeat). */
export function heartbeatFile(): string {
  return process.env.WORKER_HEARTBEAT_FILE?.trim() || DEFAULT_HEARTBEAT_FILE
}

/** Writes `now` atomically (temp file + rename), so readers never see a partial value. */
export function writeHeartbeat(path: string, now: number = Date.now()): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, String(now))
  renameSync(tmp, path)
}

/** Removes a heartbeat left over from a previous process (container restart). */
export function clearHeartbeat(path: string): void {
  rmSync(path, { force: true })
}

/**
 * True if the file holds a timestamp at most `maxAgeMs` old. A missing or
 * unreadable file, garbage, or a timestamp in the future (beyond small clock
 * jitter) counts as not fresh.
 */
export function isHeartbeatFresh(
  path: string,
  maxAgeMs: number,
  now: number = Date.now(),
): boolean {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8').trim()
  } catch {
    return false
  }
  if (!/^\d+$/.test(raw)) return false
  const age = now - Number(raw)
  return age >= -5_000 && age <= maxAgeMs
}

/** Minimal query interface (pg.Pool satisfies it). */
export interface Queryable {
  query(sql: string): Promise<unknown>
}

/**
 * Writes the heartbeat from the worker's main loop: `tick()` is cheap when
 * called often and only checks the database (`SELECT 1`) and writes the file
 * once per interval. Errors (database down, file not writable) propagate to
 * the caller; the heartbeat then simply goes stale.
 */
export class Heartbeat {
  private nextBeat = 0

  constructor(
    private readonly pool: Queryable,
    private readonly path: string = heartbeatFile(),
    private readonly intervalMs: number = HEARTBEAT_INTERVAL_MS,
  ) {}

  /** Returns true if a heartbeat was written in this call. */
  async tick(now: number = Date.now()): Promise<boolean> {
    if (now < this.nextBeat) return false
    // Retry soon after a failure, but not on every 2 s loop iteration.
    this.nextBeat = now + this.intervalMs
    await this.pool.query('SELECT 1')
    writeHeartbeat(this.path, now)
    return true
  }
}
