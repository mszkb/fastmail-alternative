// Sign-in with Google/Microsoft (#36). The backend under test has no OAuth
// app configured, so only the parts without a provider are covered here;
// the full flow runs in apps/server-php/tests/Integration/OAuthTest.php.
import { describe, expect, it } from 'vitest'
import { API_URL, Client } from '../src/client'

describe.skipIf(!API_URL)('oauth', () => {
  const client = new Client()

  it('needs a session except for the callback', async () => {
    expect((await client.request('GET', '/api/oauth/providers')).status).toBe(401)
    const start = await client.request('POST', '/api/oauth/google/start', {
      body: {},
      pattern: '/api/oauth/{provider}/start',
    })
    expect(start.status).toBe(401)
  })

  it('GET /api/oauth/providers lists the configured providers', async () => {
    await client.signIn()
    const response = await client.request('GET', '/api/oauth/providers')
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      providers: { google: expect.any(Boolean), microsoft: expect.any(Boolean) },
    })
  })

  it('POST /api/oauth/{provider}/start rejects unknown and unconfigured providers', async () => {
    await client.signIn()
    const pattern = '/api/oauth/{provider}/start'
    expect(
      (await client.request('POST', '/api/oauth/yahoo/start', { body: {}, pattern })).status,
    ).toBe(404)
    const providers = (await client.request('GET', '/api/oauth/providers')).body as {
      providers: Record<string, boolean>
    }
    if (!providers.providers.google) {
      const response = await client.request('POST', '/api/oauth/google/start', {
        body: {},
        pattern,
      })
      expect(response.status).toBe(409)
      expect(response.body).toMatchObject({ code: 'NOT_CONFIGURED' })
    }
  })

  it('GET /api/oauth/callback redirects to the PWA, also without a valid state', async () => {
    const response = await new Client().request('GET', '/api/oauth/callback?state=unknown&code=x', {
      headers: { 'sec-fetch-site': 'cross-site' },
      pattern: '/api/oauth/callback',
    })
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/?oauth=error&reason=state')
  })
})
