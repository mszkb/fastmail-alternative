/**
 * Tests for structured logging redaction (roadmap 1.7), the metrics
 * endpoint gating and the health endpoint semantics.
 */
import { PassThrough } from 'node:stream'
import { afterAll, describe, expect, it } from 'vitest'
import pino from 'pino'
import { buildApp } from '../src/app'
import { buildLoggerOptions } from '../src/logging'
import { pool } from '../src/db'

describe('log redaction via pino', () => {
  it('censors passwords, tokens and subjects in emitted log lines', async () => {
    let output = ''
    const stream = new PassThrough()
    stream.on('data', (chunk) => {
      output += String(chunk)
    })
    const log = pino(buildLoggerOptions(), stream)

    log.info(
      {
        password: 'super-secret-password',
        token: 'session-token-123',
        subject: 'Vertraulicher Betreff',
        nested: { token: 'nested-token' },
        safe: 'plain value',
      },
      'test message',
    )
    await Promise.resolve()

    expect(output).toContain('test message')
    expect(output).toContain('[REDACTED]')
    expect(output).not.toContain('super-secret-password')
    expect(output).not.toContain('session-token-123')
    expect(output).not.toContain('Vertraulicher Betreff')
    expect(output).not.toContain('nested-token')
    expect(output).toContain('plain value')
  })
})

describe('metrics endpoint', () => {
  const app = buildApp({ logger: false })
  const saved = process.env.METRICS_TOKEN

  afterAll(() => {
    if (saved === undefined) delete process.env.METRICS_TOKEN
    else process.env.METRICS_TOKEN = saved
    void app.close()
  })

  it('is disabled (404) without METRICS_TOKEN', async () => {
    delete process.env.METRICS_TOKEN
    const res = await app.inject({ method: 'GET', url: '/api/metrics' })
    expect(res.statusCode).toBe(404)
  })

  it('requires the bearer token when configured', async () => {
    process.env.METRICS_TOKEN = 'test-metrics-token'
    const noAuth = await app.inject({ method: 'GET', url: '/api/metrics' })
    expect(noAuth.statusCode).toBe(401)

    const wrong = await app.inject({
      method: 'GET',
      url: '/api/metrics',
      headers: { authorization: 'Bearer wrong' },
    })
    expect(wrong.statusCode).toBe(401)

    const ok = await app.inject({
      method: 'GET',
      url: '/api/metrics',
      headers: { authorization: 'Bearer test-metrics-token' },
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.body).toContain('http_requests_total')
    expect(ok.body).toContain('process_uptime_seconds')
    expect(ok.body).toContain('http_request_duration_seconds')
  })
})

describe('health endpoint', () => {
  const app = buildApp({ logger: false })

  afterAll(async () => {
    void app.close()
    await pool.end().catch(() => {})
  })

  it('reports degraded (503) when the database is unreachable', async () => {
    if (process.env.DATABASE_URL) return // covered by the ok-case below
    const res = await app.inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({
      status: 'degraded',
      service: 'api',
      checks: { database: 'down' },
    })
  })

  describe.skipIf(!process.env.DATABASE_URL)('with a database', () => {
    it('reports ok (200) when the database is reachable', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/health' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ status: 'ok', service: 'api', checks: { database: 'ok' } })
    })
  })
})
