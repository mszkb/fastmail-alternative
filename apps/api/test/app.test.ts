import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app'

describe('GET /api/health', () => {
  it('reports degraded (503) when the database is unreachable', async () => {
    if (process.env.DATABASE_URL) return // the ok-case below covers this
    const app = buildApp({ logger: false })

    const res = await app.inject({ method: 'GET', url: '/api/health' })

    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({
      status: 'degraded',
      service: 'api',
      checks: { database: 'down' },
    })
    await app.close()
  })

  describe.skipIf(!process.env.DATABASE_URL)('with a database', () => {
    it('reports ok (200) including the database check', async () => {
      const app = buildApp({ logger: false })

      const res = await app.inject({ method: 'GET', url: '/api/health' })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({
        status: 'ok',
        service: 'api',
        version: '0.0.0',
        checks: { database: 'ok' },
      })
      await app.close()
    })
  })
})
