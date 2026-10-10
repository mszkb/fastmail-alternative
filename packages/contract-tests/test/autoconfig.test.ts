// Settings detection for domains without a preset (#165). Only the checks
// that need no outbound network: session and input validation.
import { describe, expect, it } from 'vitest'
import { API_URL, Client } from '../src/client'

describe.skipIf(!API_URL)('GET /api/autoconfig', () => {
  const client = new Client()

  it('needs a session', async () => {
    const anonymous = new Client()
    expect((await anonymous.request('GET', '/api/autoconfig?domain=example.org')).status).toBe(401)
  })

  it('rejects missing and invalid domains', async () => {
    await client.signIn()
    for (const query of ['', '?domain=', '?domain=localhost', '?domain=a%2Fb.example.org']) {
      const response = await client.request('GET', `/api/autoconfig${query}`)
      expect(response.status, query).toBe(400)
    }
  })
})
