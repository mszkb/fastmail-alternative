// Mail endpoints end to end over HTTP (#96, #104, #105, #107): send a mail
// to the account itself, sync it, then read, act on, search, reply to and
// draft from it. Needs GREENMAIL_HOST (GreenMail, plain ports 3143/3025, any
// login accepted), a backend started with MAIL_ALLOW_PRIVATE_HOSTS=1 and
// MAIL_INSECURE_TRANSPORT=1, and CONTRACT_CRON_CMD: a command that runs the
// queued jobs once against the same database, e.g.
// `php apps/server-php/bin/cron.php` (it inherits this process' environment).
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { API_URL, Client } from '../src/client'

const GREENMAIL = process.env.GREENMAIL_HOST ?? ''
const IMAP_PORT = Number(process.env.GREENMAIL_IMAP_PORT ?? 3143)
const SMTP_PORT = Number(process.env.GREENMAIL_SMTP_PORT ?? 3025)
const CRON_CMD = process.env.CONTRACT_CRON_CMD ?? ''
const UNKNOWN = '00000000-0000-4000-8000-000000000000'

interface Folder {
  id: string
  path: string
  specialUse: string | null
}
interface ListItem {
  id: string
  subject: string
  threadId: string
  hasAttachments: boolean
}

function runJobs(): void {
  execSync(CRON_CMD, { stdio: 'ignore', timeout: 60_000 })
}

describe.skipIf(!API_URL || !GREENMAIL || !CRON_CMD)('mail endpoints', () => {
  const client = new Client()
  const address = `contract-mail-${Date.now()}@example.org`
  const subject = `Contract mail ${Date.now()}`
  let accountId = ''
  let inbox: Folder
  let message: ListItem

  const inboxMessages = async (): Promise<ListItem[]> => {
    const folders = (await client.request('GET', `/api/accounts/${accountId}/folders`)).body as {
      folders: Folder[]
    }
    const found = folders.folders.find((f) => f.path === 'INBOX')
    if (!found) return []
    inbox = found
    const list = await client.request('GET', `/api/folders/${found.id}/messages`)
    return (list.body as { messages: ListItem[] }).messages
  }

  beforeAll(async () => {
    await client.signIn()
    const created = await client.request('POST', '/api/accounts', {
      body: {
        emailAddress: address,
        displayName: 'Contract Mail',
        imap: { host: GREENMAIL, port: IMAP_PORT, user: address, password: 'contract-pw' },
        smtp: { host: GREENMAIL, port: SMTP_PORT },
      },
    })
    expect(created.status).toBe(201)
    accountId = (created.body as { account: { id: string } }).account.id
  })

  afterAll(async () => {
    if (accountId) await client.request('DELETE', `/api/accounts/${accountId}`)
  })

  it('all need a session', async () => {
    const anonymous = new Client()
    for (const [method, path] of [
      ['GET', `/api/accounts/${UNKNOWN}/folders`],
      ['GET', `/api/folders/${UNKNOWN}/messages`],
      ['GET', `/api/messages/${UNKNOWN}`],
      ['GET', `/api/threads/${UNKNOWN}`],
      ['GET', `/api/accounts/${UNKNOWN}/search?q=x`],
      ['GET', `/api/accounts/${UNKNOWN}/drafts`],
      ['GET', `/api/outbox/${UNKNOWN}`],
      ['POST', '/api/outbox'],
      ['POST', '/api/messages/actions'],
      ['POST', '/api/import/config'],
    ] as const) {
      const options = method === 'POST' ? { body: {} } : {}
      expect((await anonymous.request(method, path, options)).status, path).toBe(401)
    }
  })

  it('unknown ids are 404', async () => {
    for (const path of [
      `/api/accounts/${UNKNOWN}/folders`,
      `/api/folders/${UNKNOWN}/messages`,
      `/api/messages/${UNKNOWN}`,
      `/api/messages/${UNKNOWN}/html`,
      `/api/messages/${UNKNOWN}/attachments`,
      `/api/threads/${UNKNOWN}`,
      `/api/accounts/${UNKNOWN}/drafts`,
      `/api/accounts/${UNKNOWN}/outbox`,
      `/api/outbox/${UNKNOWN}`,
      `/api/drafts/${UNKNOWN}`,
    ]) {
      expect((await client.request('GET', path)).status, path).toBe(404)
    }
    expect((await client.request('DELETE', `/api/uploads/${UNKNOWN}`)).status).toBe(404)
    expect((await client.request('POST', `/api/folders/${UNKNOWN}/load-older`)).status).toBe(404)
  })

  it('POST /api/outbox validates and sends with an uploaded attachment', async () => {
    const upload = await client.request('POST', `/api/accounts/${accountId}/uploads`, {
      raw: 'hello contract',
      headers: {
        'content-type': 'application/octet-stream',
        'x-filename': encodeURIComponent('notiz.txt'),
        'x-content-type': 'text/plain',
      },
      pattern: '/api/accounts/{id}/uploads',
    })
    expect(upload.status).toBe(201)
    const { id: uploadId } = upload.body as { id: string }

    const base = { accountId, subject, text: 'Hello contract body' }
    expect((await client.request('POST', '/api/outbox', { body: base })).status).toBe(400)
    expect(
      (await client.request('POST', '/api/outbox', { body: { ...base, to: ['kaputt'] } })).status,
    ).toBe(400)

    const sent = await client.request('POST', '/api/outbox', {
      body: { ...base, to: [address], attachmentIds: [uploadId], clientId: randomUUID() },
    })
    expect(sent.status).toBe(201)
    const outbox = sent.body as { id: string; status: string }
    expect(outbox.status).toBe('queued')
    expect((await client.request('GET', `/api/outbox/${outbox.id}`)).status).toBe(200)
    expect((await client.request('GET', `/api/accounts/${accountId}/outbox`)).status).toBe(200)
    // Only failed messages can be retried.
    expect((await client.request('POST', `/api/outbox/${outbox.id}/retry`)).status).toBe(409)
  })

  it('the mail arrives after sending and syncing', async () => {
    // Sending and the first sync are queued already; a manual sync request
    // may hit its rate limit (429) and is only a nudge.
    for (let round = 0; round < 10 && !message; round++) {
      runJobs()
      message = (await inboxMessages()).find((m) => m.subject === subject)!
      if (!message) {
        const sync = await client.request('POST', `/api/accounts/${accountId}/sync`)
        expect([200, 202, 429]).toContain(sync.status)
      }
    }
    expect(message, 'synced message').toBeDefined()
    expect(message.hasAttachments).toBe(true)
  }, 120_000)

  it('GET /api/folders/{id}/messages pages and validates', async () => {
    const page = await client.request('GET', `/api/folders/${inbox.id}/messages?limit=1`)
    expect(page.status).toBe(200)
    expect((page.body as { messages: unknown[] }).messages).toHaveLength(1)
    expect(
      (await client.request('GET', `/api/folders/${inbox.id}/messages?cursor=bogus`)).status,
    ).toBe(400)
    expect((await client.request('GET', `/api/folders/${inbox.id}/messages?limit=0`)).status).toBe(
      400,
    )
  })

  it('PATCH /api/folders/{id} rejects an invalid role', async () => {
    const response = await client.request('PATCH', `/api/folders/${inbox.id}`, {
      body: { specialUse: 'bogus' },
    })
    expect(response.status).toBe(400)
  })

  it('POST /api/folders/{id}/load-older queues a sync', async () => {
    expect((await client.request('POST', `/api/folders/${inbox.id}/load-older`)).status).toBe(202)
  })

  it('GET /api/messages/{id}, its html, attachments and thread', async () => {
    const detail = await client.request('GET', `/api/messages/${message.id}`)
    expect(detail.status).toBe(200)
    expect(detail.body).toMatchObject({ subject, folderIds: [inbox.id] })
    expect((detail.body as { text: string }).text).toContain('Hello contract body')

    const html = await client.request('GET', `/api/messages/${message.id}/html`)
    expect(html.status).toBe(200)

    const attachments = await client.request('GET', `/api/messages/${message.id}/attachments`)
    expect(attachments.status).toBe(200)
    const list = (attachments.body as { attachments: { filename: string }[] }).attachments
    expect(list.map((a) => a.filename)).toEqual(['notiz.txt'])
    const file = await client.request('GET', `/api/messages/${message.id}/attachments/0`, {
      pattern: '/api/messages/{id}/attachments/{index}',
    })
    expect(file.status).toBe(200)
    expect(file.text).toBe('hello contract')
    const missing = await client.request('GET', `/api/messages/${message.id}/attachments/9`, {
      pattern: '/api/messages/{id}/attachments/{index}',
    })
    expect(missing.status).toBe(404)

    const thread = await client.request('GET', `/api/threads/${message.threadId}`)
    expect(thread.status).toBe(200)
    expect((thread.body as { messages: { id: string }[] }).messages.map((m) => m.id)).toContain(
      message.id,
    )
  })

  it('POST /api/messages/actions marks it read and validates', async () => {
    const empty = await client.request('POST', '/api/messages/actions', {
      body: { folderId: inbox.id, messageIds: [], action: 'read' },
    })
    expect(empty.status).toBe(400)
    const read = await client.request('POST', '/api/messages/actions', {
      body: { folderId: inbox.id, messageIds: [message.id], action: 'read' },
    })
    expect(read.status).toBe(200)
    expect(read.body).toEqual({ updated: 1 })
  })

  it('GET /api/accounts/{id}/search finds it at the provider', async () => {
    const term = encodeURIComponent(subject)
    const found = await client.request('GET', `/api/accounts/${accountId}/search?subject=${term}`)
    expect(found.status).toBe(200)
    const body = found.body as { messages: { id: string }[] }
    expect(body.messages.map((m) => m.id)).toContain(message.id)
    expect((await client.request('GET', `/api/accounts/${accountId}/search`)).status).toBe(400)
  })

  it('reply draft, attachment copy, draft save, list and discard', async () => {
    const draft = await client.request('POST', `/api/messages/${message.id}/draft`)
    expect(draft.status).toBe(201)
    const again = await client.request('POST', `/api/messages/${message.id}/draft`)
    expect(again.status).toBe(200)
    const draftId = (draft.body as { id: string }).id
    expect((again.body as { id: string }).id).toBe(draftId)

    const copy = await client.request('POST', `/api/messages/${message.id}/attachments/copy`, {
      body: { accountId },
      pattern: '/api/messages/{id}/attachments/copy',
    })
    expect(copy.status).toBe(201)

    const id = randomUUID()
    const body = { accountId, to: address, subject: 'Entwurf', text: 'Hallo' }
    expect(
      (await client.request('PUT', `/api/drafts/${id}`, { body: { ...body, baseVersion: -1 } }))
        .status,
    ).toBe(400)
    const created = await client.request('PUT', `/api/drafts/${id}`, { body })
    expect(created.status).toBe(201)
    const updated = await client.request('PUT', `/api/drafts/${id}`, {
      body: { ...body, text: 'Neu', baseVersion: 1 },
    })
    expect(updated.status).toBe(200)
    const conflict = await client.request('PUT', `/api/drafts/${id}`, {
      body: { ...body, text: 'Alt', baseVersion: 1 },
    })
    expect(conflict.status).toBe(409)
    expect((await client.request('GET', `/api/drafts/${id}`)).status).toBe(200)
    const drafts = await client.request('GET', `/api/accounts/${accountId}/drafts`)
    expect((drafts.body as { drafts: { id: string }[] }).drafts.map((d) => d.id)).toContain(id)
    expect((await client.request('DELETE', `/api/drafts/${id}`)).status).toBe(204)
    expect((await client.request('GET', `/api/drafts/${id}`)).status).toBe(404)
  })

  it('DELETE /api/uploads/{id} removes a pending upload', async () => {
    const upload = await client.request('POST', `/api/accounts/${accountId}/uploads`, {
      raw: 'x',
      headers: { 'content-type': 'application/octet-stream' },
      pattern: '/api/accounts/{id}/uploads',
    })
    const { id } = upload.body as { id: string }
    expect((await client.request('DELETE', `/api/uploads/${id}`)).status).toBe(204)
    expect((await client.request('DELETE', `/api/uploads/${id}`)).status).toBe(404)
  })

  it('POST /api/import/config rejects foreign files', async () => {
    const response = await client.request('POST', '/api/import/config', {
      body: { format: 'something-else', version: 1, accounts: [] },
    })
    expect(response.status).toBe(400)
  })
})
