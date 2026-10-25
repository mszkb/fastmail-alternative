// Device-bound bearer tokens for native clients (#138).
import { describe, expect, it } from 'vitest'
import { API_URL, Client, USER } from '../src/client'

describe.skipIf(!API_URL)('native clients: bearer token', () => {
  // A native app sends neither Sec-Fetch-Site nor a cookie.
  const app = new Client()
  const native = (token: string, extra: Record<string, string> = {}) => ({
    headers: { 'sec-fetch-site': '', authorization: `Bearer ${token}`, ...extra },
  })
  let token = ''

  it('POST /api/auth/login with client native returns a token instead of the cookie', async () => {
    await new Client().signIn() // creates the user on a fresh backend
    const response = await app.request('POST', '/api/auth/login', {
      body: { ...USER, client: 'native', deviceName: 'contract app', platform: 'ios' },
      headers: { 'sec-fetch-site': '' },
    })
    expect(response.status).toBe(200)
    expect(response.headers.getSetCookie()).toEqual([])
    expect(app.hasSession).toBe(false)
    token = (response.body as { token: string }).token
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('rejects a native login without a native platform', async () => {
    const response = await app.request('POST', '/api/auth/login', {
      body: { ...USER, client: 'native', platform: 'desktop' },
      headers: { 'sec-fetch-site': '' },
    })
    expect(response.status).toBe(400)
  })

  it('the token authenticates in the Authorization header, not as cookie', async () => {
    const status = await app.request('GET', '/api/auth/status', native(token))
    expect(status.body).toEqual({ needsSetup: false, authenticated: true, email: USER.email })
    const devices = await app.request('GET', '/api/auth/devices', native(token))
    expect(devices.status).toBe(200)
    expect(
      (devices.body as { devices: { platform: string; isCurrent: boolean }[] }).devices,
    ).toContainEqual(expect.objectContaining({ platform: 'ios', isCurrent: true }))
    const asCookie = await app.request('GET', '/api/auth/devices', {
      headers: { cookie: `fma_session=${token}` },
    })
    expect(asCookie.status).toBe(401)
  })

  it('logout with the token ends it (also cross-site: no origin check for bearer requests)', async () => {
    const logout = await app.request(
      'DELETE',
      '/api/auth/session',
      native(token, { 'sec-fetch-site': 'cross-site' }),
    )
    expect(logout.status).toBe(204)
    expect((await app.request('GET', '/api/auth/devices', native(token))).status).toBe(401)
  })
})
