import { describe, expect, it } from 'vitest'
import { API_URL, Client, USER } from '../src/client'

// One file, sequential: setup/login first, logout last.
describe.skipIf(!API_URL)('auth', () => {
  const client = new Client()

  it('GET /api/auth/status without a session', async () => {
    const response = await client.request('GET', '/api/auth/status')
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ authenticated: false, needsSetup: expect.any(Boolean) })
  })

  it('POST /api/auth/setup rejects a wrong setup code', async () => {
    const response = await client.request('POST', '/api/auth/setup', {
      body: { ...USER, setupCode: 'wrong' },
    })
    expect(response.status).toBe(403)
  })

  it('POST /api/auth/login rejects a wrong password', async () => {
    const response = await client.request('POST', '/api/auth/login', {
      body: { email: USER.email, password: 'wrong-password-123' },
    })
    expect(response.status).toBe(401)
    expect(response.body).toEqual({ message: 'Invalid email or password' })
    expect(client.hasSession).toBe(false)
  })

  it('sets an HttpOnly, SameSite=Strict session cookie on sign-in', async () => {
    await client.signIn()
    expect(client.hasSession).toBe(true)
    const status = await client.request('GET', '/api/auth/status')
    expect(status.body).toEqual({ needsSetup: false, authenticated: true, email: USER.email })
  })

  it('POST /api/auth/setup is closed once a user exists', async () => {
    const response = await new Client().request('POST', '/api/auth/setup', {
      body: { email: 'other@example.org', password: 'another-password', setupCode: 'x' },
    })
    expect(response.status).toBe(403)
  })

  it('auth routes answer 401 without a session', async () => {
    const anonymous = new Client()
    expect((await anonymous.request('GET', '/api/auth/devices')).status).toBe(401)
    expect((await anonymous.request('DELETE', '/api/auth/session')).status).toBe(401)
    expect(
      (
        await anonymous.request('POST', '/api/auth/password', {
          body: { currentPassword: 'x', newPassword: 'y' },
        })
      ).status,
    ).toBe(401)
  })

  it('GET /api/auth/devices lists the current device', async () => {
    const response = await client.request('GET', '/api/auth/devices')
    expect(response.status).toBe(200)
    const { devices } = response.body as { devices: { isCurrent: boolean }[] }
    expect(devices.some((d) => d.isCurrent)).toBe(true)
  })

  it('DELETE /api/auth/devices/{id} answers 404 for an unknown device', async () => {
    const response = await client.request(
      'DELETE',
      '/api/auth/devices/00000000-0000-4000-8000-000000000000',
    )
    expect(response.status).toBe(404)
  })

  it('DELETE /api/auth/devices/{id} signs out another device', async () => {
    const other = new Client()
    await other.signIn()
    const { devices } = (await client.request('GET', '/api/auth/devices')).body as {
      devices: { id: string; isCurrent: boolean }[]
    }
    const { devices: own } = (await other.request('GET', '/api/auth/devices')).body as {
      devices: { id: string; isCurrent: boolean }[]
    }
    const otherId = own.find((d) => d.isCurrent)!.id
    expect(devices.map((d) => d.id)).toContain(otherId)
    expect((await client.request('DELETE', `/api/auth/devices/${otherId}`)).status).toBe(204)
    expect((await other.request('GET', '/api/auth/devices')).status).toBe(401)
  })

  it('POST /api/auth/password rejects a wrong current password', async () => {
    const response = await client.request('POST', '/api/auth/password', {
      body: { currentPassword: 'not-the-password', newPassword: 'whatever-new-1' },
    })
    expect(response.status).toBe(403)
  })

  it('DELETE /api/auth/session logs out', async () => {
    const response = await client.request('DELETE', '/api/auth/session')
    expect(response.status).toBe(204)
    expect(client.hasSession).toBe(false)
    expect((await client.request('GET', '/api/auth/devices')).status).toBe(401)
  })
})
