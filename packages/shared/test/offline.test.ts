import { describe, expect, it } from 'vitest'
import type { MessageAction, MessageFlags } from '../src/mail'
import {
  MAX_CONFLICT_ATTEMPTS,
  MAX_REPLAY_ATTEMPTS,
  applyMessageAction,
  overlayPendingActions,
  pendingLabel,
  queueOperation,
  replayDecision,
  selectEvictions,
  type QueuedOperation,
} from '../src/offline'

const ACCOUNT = 'a1'
const INBOX = 'f-inbox'
let counter = 0

function action(
  act: MessageAction,
  ids: string[],
  folderId = INBOX,
  accountId = ACCOUNT,
): QueuedOperation {
  return {
    kind: 'action',
    id: `op-${++counter}`,
    accountId,
    createdAt: new Date(0).toISOString(),
    attempts: 0,
    request: {
      folderId,
      messageIds: ids,
      action: act,
      ...(act === 'move' ? { targetFolderId: 'f-other' } : {}),
    },
  }
}

function send(): QueuedOperation {
  const id = `op-${++counter}`
  return {
    kind: 'send',
    id,
    accountId: ACCOUNT,
    createdAt: new Date(0).toISOString(),
    attempts: 0,
    request: { accountId: ACCOUNT, to: ['a@example.com'], subject: 'S', text: 'T', clientId: id },
  }
}

function build(...ops: QueuedOperation[]): QueuedOperation[] {
  return ops.reduce<QueuedOperation[]>((queue, op) => queueOperation(queue, op), [])
}

function summary(queue: QueuedOperation[]): string[] {
  return queue.map((op) =>
    op.kind === 'send' ? 'send' : `${op.request.action}:${op.request.messageIds.join(',')}`,
  )
}

describe('queueOperation', () => {
  it('keeps operations in order', () => {
    const queue = build(action('flag', ['m1']), send(), action('archive', ['m2']))
    expect(summary(queue)).toEqual(['flag:m1', 'send', 'archive:m2'])
  })

  it('coalesces read -> unread -> read into one read', () => {
    const queue = build(action('read', ['m1']), action('unread', ['m1']), action('read', ['m1']))
    expect(summary(queue)).toEqual(['read:m1'])
  })

  it('only removes the superseded ids of a batch', () => {
    const queue = build(action('read', ['m1', 'm2']), action('unread', ['m2']))
    expect(summary(queue)).toEqual(['read:m1', 'unread:m2'])
  })

  it('does not mix flag groups', () => {
    const queue = build(action('read', ['m1']), action('flag', ['m1']), action('unflag', ['m1']))
    expect(summary(queue)).toEqual(['read:m1', 'unflag:m1'])
  })

  it('does not coalesce across a move of the message', () => {
    const queue = build(
      action('read', ['m1']),
      action('archive', ['m1']),
      action('unread', ['m1'], 'f-archive'),
    )
    expect(summary(queue)).toEqual(['read:m1', 'archive:m1', 'unread:m1'])
  })

  it('does not coalesce actions of other folders or accounts', () => {
    const queue = build(
      action('read', ['m1'], 'f-x'),
      action('read', ['m1'], INBOX, 'a2'),
      action('unread', ['m1']),
    )
    expect(summary(queue)).toEqual(['read:m1', 'read:m1', 'unread:m1'])
  })

  it('does not change the input queue', () => {
    const first = build(action('read', ['m1', 'm2']))
    const next = queueOperation(first, action('unread', ['m1']))
    expect(summary(first)).toEqual(['read:m1,m2'])
    expect(summary(next)).toEqual(['read:m2', 'unread:m1'])
  })
})

describe('replayDecision', () => {
  it('maps statuses', () => {
    expect(replayDecision(200, 0)).toBe('done')
    expect(replayDecision(201, 0)).toBe('done')
    expect(replayDecision('network', 50)).toBe('retry')
    expect(replayDecision(401, 0)).toBe('unauthorized')
    expect(replayDecision(404, 0)).toBe('drop')
    expect(replayDecision(400, 0)).toBe('drop')
    expect(replayDecision(503, 0)).toBe('retry')
    expect(replayDecision(429, 0)).toBe('retry')
  })

  it('gives up conflicts and server errors after a few attempts', () => {
    expect(replayDecision(409, MAX_CONFLICT_ATTEMPTS - 2)).toBe('retry')
    expect(replayDecision(409, MAX_CONFLICT_ATTEMPTS - 1)).toBe('drop')
    expect(replayDecision(500, MAX_REPLAY_ATTEMPTS - 2)).toBe('retry')
    expect(replayDecision(500, MAX_REPLAY_ATTEMPTS - 1)).toBe('drop')
  })
})

describe('applyMessageAction / overlayPendingActions', () => {
  const flags = (seen: boolean, flagged = false): MessageFlags => ({
    seen,
    flagged,
    answered: false,
  })
  const list = [
    { id: 'm1', flags: flags(false) },
    { id: 'm2', flags: flags(true) },
    { id: 'm3', flags: flags(false) },
  ]

  it('sets flags without touching the input', () => {
    const result = applyMessageAction(list, 'read', ['m1'])
    expect(result[0]!.flags.seen).toBe(true)
    expect(list[0]!.flags.seen).toBe(false)
    expect(result[1]).toBe(list[1])
    expect(applyMessageAction(list, 'flag', ['m2'])[1]!.flags.flagged).toBe(true)
  })

  it('removes moved messages', () => {
    expect(applyMessageAction(list, 'move', ['m2']).map((m) => m.id)).toEqual(['m1', 'm3'])
  })

  it('overlays only the queued actions of the folder', () => {
    const queue = build(
      action('read', ['m1']),
      action('delete', ['m3']),
      action('flag', ['m2'], 'f-other'),
      send(),
    )
    const result = overlayPendingActions(list, INBOX, queue)
    expect(result.map((m) => [m.id, m.flags.seen, m.flags.flagged])).toEqual([
      ['m1', true, false],
      ['m2', true, false],
    ])
  })
})

describe('selectEvictions', () => {
  it('evicts nothing within the limits', () => {
    expect(
      selectEvictions([{ key: 'a', size: 10, accessedAt: 1 }], { maxBytes: 10, maxEntries: 1 }),
    ).toEqual([])
  })

  it('evicts least recently used entries first and never pinned ones', () => {
    const entries = [
      { key: 'pinned', size: 50, accessedAt: 0, pinned: true },
      { key: 'old', size: 30, accessedAt: 1 },
      { key: 'mid', size: 30, accessedAt: 2 },
      { key: 'new', size: 30, accessedAt: 3 },
    ]
    expect(selectEvictions(entries, { maxBytes: 100, maxEntries: 10 })).toEqual(['old', 'mid'])
    expect(selectEvictions(entries, { maxBytes: 1000, maxEntries: 2 })).toEqual(['old', 'mid'])
    // Pinned entries alone over the limit: everything else goes, they stay.
    expect(selectEvictions(entries, { maxBytes: 10, maxEntries: 10 })).toEqual([
      'old',
      'mid',
      'new',
    ])
  })
})

it('pendingLabel', () => {
  expect(pendingLabel(1)).toBe('1 Aktion ausstehend')
  expect(pendingLabel(3)).toBe('3 Aktionen ausstehend')
})
