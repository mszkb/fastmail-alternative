// Accounts and identities against a real mail server: needs GREENMAIL_HOST
// (GreenMail with plain ports 3143/3025, any login accepted) and a backend
// started with MAIL_ALLOW_PRIVATE_HOSTS=1 and MAIL_INSECURE_TRANSPORT=1.
import { describe, expect, it } from 'vitest'
import { API_URL, Client } from '../src/client'

const GREENMAIL = process.env.GREENMAIL_HOST ?? ''
const IMAP_PORT = Number(process.env.GREENMAIL_IMAP_PORT ?? 3143)
const SMTP_PORT = Number(process.env.GREENMAIL_SMTP_PORT ?? 3025)

interface Account {
  id: string
  emailAddress: string
  displayName: string
}

describe.skipIf(!API_URL || !GREENMAIL)('accounts and identities', () => {
  const client = new Client()
  const address = `contract-${Date.now()}@example.org`
  let account: Account

  const create = (overrides: Record<string, unknown> = {}) =>
    client.request('POST', '/api/accounts', {
      body: {
        emailAddress: address,
        displayName: 'Contract',
        imap: { host: GREENMAIL, port: IMAP_PORT, user: address, password: 'contract-pw' },
        smtp: { host: GREENMAIL, port: SMTP_PORT },
        ...overrides,
      },
    })

  it('needs a session', async () => {
    expect((await new Client().request('GET', '/api/accounts')).status).toBe(401)
  })

  it('POST /api/accounts rejects invalid input', async () => {
    await client.signIn()
    expect((await create({ emailAddress: 'not-an-address' })).status).toBe(400)
    expect(
      (await create({ imap: { host: GREENMAIL, port: 0, user: 'u', password: 'p' } })).status,
    ).toBe(400)
  })

  it('POST /api/accounts answers 422 with the failed stage', async () => {
    const response = await create({
      imap: { host: GREENMAIL, port: 3999, user: address, password: 'x' },
    })
    expect(response.status).toBe(422)
    expect(response.body).toMatchObject({
      stage: 'imap',
      test: { ok: false, code: 'CONNECTION_REFUSED' },
    })
  })

  it('POST /api/accounts tests the connection and creates the account', async () => {
    const response = await create()
    expect(response.status).toBe(201)
    const body = response.body as {
      account: Account
      test: { imap: { ok: boolean }; smtp: { ok: boolean } }
    }
    expect(body.test.imap.ok).toBe(true)
    expect(body.test.smtp.ok).toBe(true)
    expect(body.account).toMatchObject({ emailAddress: address, displayName: 'Contract' })
    expect(JSON.stringify(body)).not.toContain('contract-pw')
    account = body.account
  })

  it('GET /api/accounts lists it without credentials', async () => {
    const response = await client.request('GET', '/api/accounts')
    expect(response.status).toBe(200)
    expect(response.text).not.toContain('contract-pw')
    const { accounts } = response.body as { accounts: Account[] }
    expect(accounts.map((a) => a.id)).toContain(account.id)
  })

  it('PATCH /api/accounts/{id} renames and 404s for unknown ids', async () => {
    const response = await client.request('PATCH', `/api/accounts/${account.id}`, {
      body: { displayName: 'Renamed' },
      pattern: '/api/accounts/{id}',
    })
    expect(response.status).toBe(200)
    const unknown = await client.request(
      'PATCH',
      '/api/accounts/00000000-0000-4000-8000-000000000000',
      {
        body: { displayName: 'x' },
      },
    )
    expect(unknown.status).toBe(404)
  })

  it('identities: create, reject duplicates, update, delete', async () => {
    const base = `/api/accounts/${account.id}/identities`
    const list = await client.request('GET', base)
    expect(list.status).toBe(200)
    const created = await client.request('POST', base, {
      body: { name: 'Alias', emailAddress: `alias-${address}` },
    })
    expect(created.status).toBe(201)
    const { identity } = created.body as { identity: { id: string } }
    const duplicate = await client.request('POST', base, {
      body: { emailAddress: `ALIAS-${address}` },
    })
    expect(duplicate.status).toBe(409)
    expect((await client.request('POST', base, { body: { emailAddress: 'nope' } })).status).toBe(
      400,
    )
    const updated = await client.request('PATCH', `/api/identities/${identity.id}`, {
      body: { signature: '-- \nGruß' },
    })
    expect(updated.status).toBe(200)
    expect((await client.request('DELETE', `/api/identities/${identity.id}`)).status).toBe(204)
    expect((await client.request('DELETE', `/api/identities/${identity.id}`)).status).toBe(404)
  })

  it('DELETE /api/accounts/{id} removes it', async () => {
    expect((await client.request('DELETE', `/api/accounts/${account.id}`)).status).toBe(204)
    const { accounts } = (await client.request('GET', '/api/accounts')).body as {
      accounts: Account[]
    }
    expect(accounts.map((a) => a.id)).not.toContain(account.id)
    expect((await client.request('DELETE', `/api/accounts/${account.id}`)).status).toBe(404)
  })
})
