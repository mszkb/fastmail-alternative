// Sync status and stopping (#119). The endpoints exist only in the PHP
// backend (x-backends: [php]); against the Node backend they answer 404 and
// the tests below only check that (the PWA falls back to `syncing`).
import { describe, expect, it } from 'vitest'
import { API_URL, Client } from '../src/client'
import { spec } from '../src/openapi'

const probe = API_URL ? (await fetch(`${API_URL}/api/sync/status`)).status : 0
const supported = probe !== 0 && probe !== 404

describe.skipIf(!API_URL || supported)('sync status on a backend without it', () => {
  it('answers 404 and the spec marks the operations as PHP-only', async () => {
    expect(probe).toBe(404)
    for (const [path, method] of [
      ['/api/sync/status', 'get'],
      ['/api/sync/cancel', 'post'],
      ['/api/accounts/{id}/sync/cancel', 'post'],
    ] as const) {
      expect(spec.paths[path]?.[method]).toMatchObject({ 'x-backends': ['php'] })
    }
  })
})

describe.skipIf(!API_URL || !supported)('sync status and stop', () => {
  const client = new Client()

  it('all need a session', async () => {
    const anonymous = new Client()
    expect((await anonymous.request('GET', '/api/sync/status')).status).toBe(401)
    expect((await anonymous.request('POST', '/api/sync/cancel')).status).toBe(401)
  })

  it('rejects cross-origin stop requests', async () => {
    await client.signIn()
    const response = await client.request('POST', '/api/sync/cancel', {
      headers: { 'sec-fetch-site': 'cross-site' },
    })
    expect(response.status).toBe(403)
  })

  it('GET /api/sync/status lists every account with its state', async () => {
    const response = await client.request('GET', '/api/sync/status')
    expect(response.status).toBe(200)
    const accounts = (response.body as { accounts: { accountId: string; state: string }[] })
      .accounts
    const listed = (await client.request('GET', '/api/accounts')).body as {
      accounts: { id: string }[]
    }
    expect(accounts.map((a) => a.accountId)).toEqual(listed.accounts.map((a) => a.id))
  })

  it('POST /api/sync/cancel and /api/accounts/{id}/sync/cancel', async () => {
    const all = await client.request('POST', '/api/sync/cancel')
    expect(all.status).toBe(200)
    const missing = await client.request(
      'POST',
      '/api/accounts/00000000-0000-4000-8000-000000000000/sync/cancel',
    )
    expect(missing.status).toBe(404)
    const accounts = (all.body as { accounts: { accountId: string }[] }).accounts
    if (accounts[0]) {
      const one = await client.request('POST', `/api/accounts/${accounts[0].accountId}/sync/cancel`)
      expect(one.status).toBe(200)
      expect(one.body).toMatchObject({ accountId: accounts[0].accountId })
    }
  })
})
