// Settings, storage, export, sync and push basics (no mail server needed).
import { describe, expect, it } from 'vitest'
import { API_URL, Client } from '../src/client'

describe.skipIf(!API_URL)('settings, storage, export, sync, push', () => {
  const client = new Client()

  it('all need a session', async () => {
    const anonymous = new Client()
    for (const path of [
      '/api/settings',
      '/api/storage',
      '/api/export/config',
      '/api/push/subscriptions',
      '/api/push/vapid-public-key',
    ]) {
      expect((await anonymous.request('GET', path)).status, path).toBe(401)
    }
  })

  it('GET/PUT /api/settings toggles the unified inbox', async () => {
    await client.signIn()
    expect(
      (await client.request('PUT', '/api/settings', { body: { unifiedInbox: true } })).body,
    ).toEqual({
      unifiedInbox: true,
    })
    expect((await client.request('GET', '/api/settings')).body).toEqual({ unifiedInbox: true })
    expect(
      (await client.request('PUT', '/api/settings', { body: { unifiedInbox: 'yes' } })).status,
    ).toBe(400)
    await client.request('PUT', '/api/settings', { body: { unifiedInbox: false } })
    expect((await client.request('GET', '/api/unified/inbox')).status).toBe(404)
  })

  it('GET /api/storage and /api/export/config answer with their shapes', async () => {
    expect((await client.request('GET', '/api/storage')).status).toBe(200)
    const exported = await client.request('GET', '/api/export/config')
    expect(exported.status).toBe(200)
    expect(exported.text).not.toMatch(/password/i)
  })

  it('POST /api/sync answers', async () => {
    expect((await client.request('POST', '/api/sync')).status).toBe(200)
  })

  it('push: key endpoint and an empty subscription list', async () => {
    expect((await client.request('GET', '/api/push/vapid-public-key')).status).toBe(200)
    const list = await client.request('GET', '/api/push/subscriptions')
    expect(list.status).toBe(200)
    const bad = await client.request('POST', '/api/push/subscriptions', {
      body: { endpoint: 'not a url', keys: { p256dh: 'x', auth: 'y' } },
    })
    expect(bad.status).toBe(400)
  })
})
