import { describe, expect, it } from 'vitest'
import {
  ForegroundSyncPolicy,
  accountDataChanged,
  mergeFirstPage,
  type AccountSyncState,
} from '../src/foreground-sync'

function clock(start = 1_000_000) {
  let now = start
  return { now: () => now, advance: (ms: number) => (now += ms) }
}

describe('ForegroundSyncPolicy', () => {
  it('throttles trigger events but lets forced triggers through', () => {
    const time = clock()
    const policy = new ForegroundSyncPolicy({ minTriggerIntervalMs: 15_000, now: time.now })
    expect(policy.trigger()).toBe(true)
    // focus + visibilitychange arrive together
    expect(policy.trigger()).toBe(false)
    time.advance(14_999)
    expect(policy.trigger()).toBe(false)
    expect(policy.trigger(true)).toBe(true)
    time.advance(15_000)
    expect(policy.trigger()).toBe(true)
  })

  it('polls while syncing inside the window and stops afterwards', () => {
    const time = clock()
    const policy = new ForegroundSyncPolicy({
      pollIntervalMs: 3_000,
      pollWindowMs: 10_000,
      now: time.now,
    })
    // No trigger yet: the regular refresh never starts fast polling.
    expect(policy.nextPollDelay(true)).toBeNull()
    policy.trigger()
    expect(policy.nextPollDelay(true)).toBe(3_000)
    time.advance(9_000)
    expect(policy.nextPollDelay(true)).toBe(3_000)
    time.advance(1_000)
    expect(policy.nextPollDelay(true)).toBeNull()
  })

  it('stops polling as soon as nothing syncs anymore, and on stop()', () => {
    const time = clock()
    const policy = new ForegroundSyncPolicy({ now: time.now })
    policy.trigger()
    expect(policy.nextPollDelay(false)).toBeNull()
    // A later refresh that still sees a sync does not resume polling.
    expect(policy.nextPollDelay(true)).toBeNull()
    time.advance(60_000)
    policy.trigger()
    policy.stop()
    expect(policy.nextPollDelay(true)).toBeNull()
  })
})

describe('accountDataChanged', () => {
  const base: AccountSyncState = {
    id: 'a',
    lastSyncAt: '2026-10-03T10:00:00.000Z',
    syncing: false,
    unreadCount: 3,
  }

  it('detects finished syncs and changed unread counts', () => {
    expect(accountDataChanged(base, { ...base, lastSyncAt: '2026-10-03T10:02:00.000Z' })).toBe(true)
    expect(accountDataChanged({ ...base, syncing: true }, base)).toBe(true)
    expect(accountDataChanged(base, { ...base, unreadCount: 4 })).toBe(true)
  })

  it('ignores unchanged state, a starting sync and unknown history', () => {
    expect(accountDataChanged(base, { ...base })).toBe(false)
    expect(accountDataChanged(base, { ...base, syncing: true })).toBe(false)
    expect(accountDataChanged(undefined, base)).toBe(false)
    expect(accountDataChanged({ ...base, id: 'b' }, base)).toBe(false)
  })
})

describe('mergeFirstPage', () => {
  const m = (id: string) => ({ id })
  const ids = (list: { id: string }[]) => list.map((x) => x.id)

  it('takes the new first page when nothing beyond it was loaded', () => {
    const current = { messages: [m('3'), m('2'), m('1')], nextCursor: 'c1' }
    const page = { messages: [m('4'), m('3'), m('2')], nextCursor: 'c2' }
    const merged = mergeFirstPage(current, page)
    // '1' follows the boundary '2' and stays; the loaded cursor stays valid.
    expect(ids(merged.messages)).toEqual(['4', '3', '2', '1'])
    expect(merged.nextCursor).toBe('c1')

    const same = mergeFirstPage(
      { messages: [m('2'), m('1')], nextCursor: 'old' },
      {
        messages: [m('3'), m('2'), m('1')],
        nextCursor: 'new',
      },
    )
    expect(ids(same.messages)).toEqual(['3', '2', '1'])
    expect(same.nextCursor).toBe('new')
  })

  it('keeps pages loaded by scrolling and drops removed messages from the head', () => {
    const current = {
      messages: [m('9'), m('8'), m('7'), m('6'), m('5'), m('4')],
      nextCursor: 'after-4',
    }
    // '8' was deleted elsewhere, '10' arrived.
    const page = { messages: [m('10'), m('9'), m('7')], nextCursor: 'after-7' }
    const merged = mergeFirstPage(current, page)
    expect(ids(merged.messages)).toEqual(['10', '9', '7', '6', '5', '4'])
    expect(merged.nextCursor).toBe('after-4')
  })

  it('falls back to the new page when the boundary is unknown', () => {
    const current = { messages: [m('2'), m('1')], nextCursor: null }
    const page = { messages: [m('5'), m('4'), m('3')], nextCursor: 'after-3' }
    expect(mergeFirstPage(current, page)).toEqual(page)
    expect(mergeFirstPage(current, { messages: [], nextCursor: null })).toEqual({
      messages: [],
      nextCursor: null,
    })
  })
})
