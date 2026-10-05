/**
 * Tests for the worker heartbeat (roadmap 1.3, Docker healthcheck). The
 * freshness checks need no services; the Heartbeat tests run against the
 * real test database (DATABASE_URL).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import pg from 'pg'
import {
  DEFAULT_HEARTBEAT_FILE,
  Heartbeat,
  clearHeartbeat,
  heartbeatFile,
  isHeartbeatFresh,
  writeHeartbeat,
} from '../src/heartbeat'

const databaseUrl = process.env.DATABASE_URL

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fma-heartbeat-'))
  file = join(dir, 'worker-heartbeat')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('heartbeat file', () => {
  it('takes the path from WORKER_HEARTBEAT_FILE with a default', () => {
    const previous = process.env.WORKER_HEARTBEAT_FILE
    try {
      delete process.env.WORKER_HEARTBEAT_FILE
      expect(heartbeatFile()).toBe(DEFAULT_HEARTBEAT_FILE)
      process.env.WORKER_HEARTBEAT_FILE = '  '
      expect(heartbeatFile()).toBe(DEFAULT_HEARTBEAT_FILE)
      process.env.WORKER_HEARTBEAT_FILE = '/run/hb'
      expect(heartbeatFile()).toBe('/run/hb')
    } finally {
      if (previous === undefined) delete process.env.WORKER_HEARTBEAT_FILE
      else process.env.WORKER_HEARTBEAT_FILE = previous
    }
  })

  it('is fresh within the max age and stale after it', () => {
    writeHeartbeat(file, 1_000_000)
    expect(readFileSync(file, 'utf8')).toBe('1000000')
    expect(isHeartbeatFresh(file, 120_000, 1_000_000)).toBe(true)
    expect(isHeartbeatFresh(file, 120_000, 1_120_000)).toBe(true)
    expect(isHeartbeatFresh(file, 120_000, 1_120_001)).toBe(false)
  })

  it('treats missing, garbage and far-future heartbeats as not fresh', () => {
    expect(isHeartbeatFresh(file, 120_000, 1_000_000)).toBe(false)
    writeFileSync(file, 'not a number')
    expect(isHeartbeatFresh(file, 120_000, 1_000_000)).toBe(false)
    writeFileSync(file, '')
    expect(isHeartbeatFresh(file, 120_000, 1_000_000)).toBe(false)
    writeHeartbeat(file, 2_000_000)
    expect(isHeartbeatFresh(file, 120_000, 1_000_000)).toBe(false)
  })

  it('clears a leftover heartbeat and tolerates a missing one', () => {
    writeHeartbeat(file, 1_000_000)
    clearHeartbeat(file)
    expect(isHeartbeatFresh(file, 120_000, 1_000_000)).toBe(false)
    expect(() => clearHeartbeat(file)).not.toThrow()
  })

  it('healthcheck script exits 0 for a fresh and 1 for a stale heartbeat', () => {
    const script = join(import.meta.dirname, '..', 'src', 'healthcheck.ts')
    const tsx = join(import.meta.dirname, '..', 'node_modules', '.bin', 'tsx')
    const run = () =>
      spawnSync(tsx, [script], { env: { ...process.env, WORKER_HEARTBEAT_FILE: file } }).status
    expect(run()).toBe(1)
    writeHeartbeat(file)
    expect(run()).toBe(0)
    writeHeartbeat(file, Date.now() - 121_000)
    expect(run()).toBe(1)
  })
})

describe.skipIf(!databaseUrl)('Heartbeat against postgres', () => {
  let pool: pg.Pool

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: databaseUrl })
  })

  afterAll(async () => {
    await pool.end()
  })

  it('writes after a successful database check, at most once per interval', async () => {
    const heartbeat = new Heartbeat(pool, file, 30_000)
    const now = Date.now()
    expect(await heartbeat.tick(now)).toBe(true)
    expect(isHeartbeatFresh(file, 120_000, now)).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe(String(now))

    // Within the interval: no new write.
    expect(await heartbeat.tick(now + 10_000)).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe(String(now))

    expect(await heartbeat.tick(now + 30_000)).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe(String(now + 30_000))
  })

  it('does not write when the database is unreachable', async () => {
    const url = new URL(databaseUrl!)
    // Closed port on the same host: connection refused.
    url.port = '1'
    const badPool = new pg.Pool({
      connectionString: url.toString(),
      connectionTimeoutMillis: 2_000,
    })
    try {
      const heartbeat = new Heartbeat(badPool, file, 30_000)
      await expect(heartbeat.tick()).rejects.toThrow()
      expect(isHeartbeatFresh(file, 120_000)).toBe(false)
    } finally {
      await badPool.end()
    }
  })
})
