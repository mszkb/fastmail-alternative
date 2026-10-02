import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app'

describe('GET /health', () => {
  it('returns an ok status for the api service', async () => {
    const app = buildApp({ logger: false })

    const res = await app.inject({ method: 'GET', url: '/health' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok', service: 'api', version: '0.0.0' })
  })
})
