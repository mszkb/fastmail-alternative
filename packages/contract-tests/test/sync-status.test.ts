// Sync status and stopping (#119).
import { describe, expect, it } from 'vitest'
import { API_URL, Client } from '../src/client'

describe.skipIf(!API_URL)('sync status and stop', () => {
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
