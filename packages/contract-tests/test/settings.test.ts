// Settings, storage, export, sync and push basics (no mail server needed).
import { createECDH, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
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
      '/api/themes',
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
    // No credential fields or values (`credentialKind: "password"` is fine).
    expect(exported.text).not.toMatch(/"\w*password"\s*:/i)
    expect(exported.text).not.toContain('contract-pw')
  })

  it('themes: install, list, reject and delete (#126)', async () => {
    const file = readFileSync(
      new URL('../../../themes/klassisch-wie-outlook.fmatheme.json', import.meta.url),
      'utf8',
    )
    const theme = JSON.parse(file) as Record<string, unknown>
    const installed = await client.request('POST', '/api/themes', { body: theme })
    expect([200, 201]).toContain(installed.status)
    const list = await client.request('GET', '/api/themes')
    expect(list.status).toBe(200)
    expect((list.body as { themes: { id: string }[] }).themes.map((t) => t.id)).toContain(
      'klassisch-wie-outlook',
    )
    const bad = await client.request('POST', '/api/themes', { body: { ...theme, css: 'x' } })
    expect(bad.status).toBe(400)
    expect((await client.request('DELETE', '/api/themes/klassisch-wie-outlook')).status).toBe(204)
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

  it('push: subscribe, list, delete by id and by endpoint', async () => {
    const keys = () => {
      const ecdh = createECDH('prime256v1')
      ecdh.generateKeys()
      return {
        p256dh: ecdh.getPublicKey().toString('base64url'),
        auth: randomBytes(16).toString('base64url'),
      }
    }
    const first = `https://push.example.org/contract/${randomUUID()}`
    const second = `https://push.example.org/contract/${randomUUID()}`
    const ids: string[] = []
    for (const endpoint of [first, second]) {
      const created = await client.request('POST', '/api/push/subscriptions', {
        body: { endpoint, keys: keys() },
      })
      expect(created.status, endpoint).toBe(201)
      ids.push((created.body as { id: string }).id)
    }
    const listed = async () =>
      (
        (await client.request('GET', '/api/push/subscriptions')).body as {
          subscriptions: { id: string; pushService: string }[]
        }
      ).subscriptions
    const before = await listed()
    expect(before.map((s) => s.id)).toEqual(expect.arrayContaining(ids))
    // The list names only the push service, never the endpoint.
    expect(JSON.stringify(before)).not.toContain('/contract/')
    expect((await client.request('DELETE', `/api/push/subscriptions/${ids[0]}`)).status).toBe(204)
    expect((await client.request('DELETE', `/api/push/subscriptions/${ids[0]}`)).status).toBe(404)
    const byEndpoint = await client.request('DELETE', '/api/push/subscriptions', {
      body: { endpoint: second },
    })
    expect(byEndpoint.status).toBe(204)
    expect((await listed()).map((s) => s.id)).not.toContain(ids[1])
  })
})
