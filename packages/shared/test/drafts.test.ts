import { describe, expect, it } from 'vitest'
import { overlayPendingDrafts, type Draft, type SaveDraftRequest } from '../src/drafts'
import { queueOperation, type QueuedOperation } from '../src/offline'

const ACCOUNT = 'a1'
let counter = 0

function save(draftId: string, text: string, at: string, accountId = ACCOUNT): QueuedOperation {
  const body: SaveDraftRequest = {
    accountId,
    to: 'anna@example.com',
    cc: '',
    bcc: '',
    subject: 'Betreff',
    text,
    baseVersion: 1,
    force: true,
  }
  return {
    kind: 'draft',
    id: `op-${++counter}`,
    accountId,
    createdAt: at,
    attempts: 0,
    request: { draftId, body },
  }
}

function remove(draftId: string): QueuedOperation {
  return {
    kind: 'draft',
    id: `op-${++counter}`,
    accountId: ACCOUNT,
    createdAt: '2026-10-03T12:00:00.000Z',
    attempts: 0,
    request: { draftId, body: null },
  }
}

function serverDraft(id: string, updatedAt: string): Draft {
  return {
    id,
    accountId: ACCOUNT,
    identityId: null,
    to: '',
    cc: '',
    bcc: '',
    subject: 'Server',
    text: 'vom Server',
    inReplyTo: null,
    references: [],
    version: 1,
    createdAt: updatedAt,
    updatedAt,
    messageIds: ['m1'],
    attachments: [{ id: 'u1', filename: 'a.txt', contentType: 'text/plain', size: 1 }],
  }
}

describe('draft offline queue', () => {
  it('keeps only the newest queued save or delete of a draft', () => {
    let queue: QueuedOperation[] = []
    queue = queueOperation(queue, save('d1', 'eins', '2026-10-03T10:00:00.000Z'))
    queue = queueOperation(queue, save('d2', 'anderer', '2026-10-03T10:00:01.000Z'))
    queue = queueOperation(queue, save('d1', 'zwei', '2026-10-03T10:00:02.000Z'))
    expect(queue.map((op) => op.kind === 'draft' && op.request.body?.text)).toEqual([
      'anderer',
      'zwei',
    ])
    queue = queueOperation(queue, remove('d1'))
    expect(queue).toHaveLength(2)
    expect(queue[1]).toMatchObject({ request: { draftId: 'd1', body: null } })
  })

  it('drops queued saves of a draft when it is sent', () => {
    let queue: QueuedOperation[] = [save('d1', 'eins', '2026-10-03T10:00:00.000Z')]
    queue = queueOperation(queue, {
      kind: 'send',
      id: 'c1',
      accountId: ACCOUNT,
      createdAt: '2026-10-03T10:01:00.000Z',
      attempts: 0,
      request: {
        accountId: ACCOUNT,
        to: ['anna@example.com'],
        subject: 'Betreff',
        text: 'eins',
        clientId: 'c1',
        draftId: 'd1',
      },
    })
    expect(queue.map((op) => op.kind)).toEqual(['send'])
  })

  it('overlays queued saves and deletes on the loaded list, newest first', () => {
    const drafts = [
      serverDraft('d1', '2026-10-03T09:00:00.000Z'),
      serverDraft('d2', '2026-10-03T08:00:00.000Z'),
    ]
    const queue = [
      save('d2', 'offline geändert', '2026-10-03T10:00:00.000Z'),
      save('d3', 'offline neu', '2026-10-03T11:00:00.000Z'),
      save('x', 'anderes Konto', '2026-10-03T11:00:00.000Z', 'a2'),
      remove('d1'),
    ]
    const result = overlayPendingDrafts(drafts, ACCOUNT, queue)
    expect(result.map((d) => [d.id, d.text])).toEqual([
      ['d3', 'offline neu'],
      ['d2', 'offline geändert'],
    ])
    // Server metadata of an existing draft is kept.
    expect(result[1]).toMatchObject({ version: 1, messageIds: ['m1'] })
    // Queued saves without attachmentIds keep the attachments.
    expect(result[1]!.attachments).toHaveLength(1)
  })
})
