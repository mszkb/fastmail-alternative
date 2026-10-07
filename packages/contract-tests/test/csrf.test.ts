import { describe, expect, it } from 'vitest'
import { API_URL, Client } from '../src/client'

describe.skipIf(!API_URL)('CSRF protection', () => {
  const client = new Client()
  const post = (headers: Record<string, string>) =>
    // POST /api/health does not exist: the CSRF check answers before routing,
    // otherwise the backend answers 404/405. Works before any route is ported.
    client.request('POST', '/api/health', { body: {}, headers })

  it('rejects cross-site and same-site requests', async () => {
    for (const site of ['cross-site', 'same-site', 'none']) {
      const response = await post({ 'sec-fetch-site': site })
      expect(response.status, site).toBe(403)
      expect(response.body).toEqual({ message: 'Cross-origin request rejected' })
    }
  })

  it('rejects a foreign or null Origin without Sec-Fetch-Site', async () => {
    for (const origin of ['https://evil.example', 'null']) {
      const response = await post({ 'sec-fetch-site': '', origin })
      expect(response.status, origin).toBe(403)
    }
  })

  it('lets same-origin and non-browser requests through to the route', async () => {
    const host = new URL(API_URL).host
    const cases: Record<string, string>[] = [
      {},
      { 'sec-fetch-site': '', origin: `http://${host}` },
      { 'sec-fetch-site': '' },
    ]
    for (const headers of cases) {
      const response = await post(headers)
      expect(response.status, JSON.stringify(headers)).not.toBe(403)
    }
  })

  it('never checks safe methods', async () => {
    const response = await client.request('GET', '/api/health', {
      headers: { 'sec-fetch-site': 'cross-site' },
    })
    expect(response.status).toBe(200)
  })
})
