import { describe, expect, it } from 'vitest'
import { API_URL, Client } from '../src/client'

const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
  'cache-control': 'no-store',
}

describe.skipIf(!API_URL)('system', () => {
  const client = new Client()

  it('GET /api/health reports ok with a reachable database', async () => {
    const response = await client.request('GET', '/api/health')
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      status: 'ok',
      service: 'api',
      checks: { database: 'ok' },
    })
  })

  it('sends the security headers, also on errors', async () => {
    for (const path of ['/api/health', '/api/does-not-exist']) {
      const response = await client.request('GET', path)
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
        expect(response.headers.get(name), `${name} on ${path}`).toBe(value)
      }
    }
  })

  it('answers unknown routes with a JSON 404', async () => {
    const response = await client.request('GET', '/api/does-not-exist')
    expect(response.status).toBe(404)
    expect(response.body).toMatchObject({ message: expect.any(String) })
  })

  const metricsToken = process.env.CONTRACT_METRICS_TOKEN
  it.skipIf(metricsToken)('GET /api/metrics is disabled without METRICS_TOKEN', async () => {
    const response = await client.request('GET', '/api/metrics')
    expect(response.status).toBe(404)
  })

  it.skipIf(!metricsToken)('GET /api/metrics needs the bearer token', async () => {
    expect((await client.request('GET', '/api/metrics')).status).toBe(401)
    expect(
      (await client.request('GET', '/api/metrics', { headers: { authorization: 'Bearer wrong' } }))
        .status,
    ).toBe(401)
    const response = await client.request('GET', '/api/metrics', {
      headers: { authorization: `Bearer ${metricsToken}` },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/plain')
    expect(response.text).toContain('# TYPE http_requests_total counter')
  })
})
