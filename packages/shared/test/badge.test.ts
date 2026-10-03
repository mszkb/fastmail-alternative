import { describe, expect, it } from 'vitest'
import { formatBadgeLabel, formatBadgeTitle, unreadBadgeCount } from '../src/badge'

describe('unreadBadgeCount', () => {
  it('sums the INBOX unread counts of all accounts', () => {
    expect(unreadBadgeCount([{ unreadCount: 3 }, { unreadCount: 0 }, { unreadCount: 4 }])).toBe(7)
    expect(unreadBadgeCount([])).toBe(0)
  })

  it('ignores invalid counts', () => {
    expect(
      unreadBadgeCount([{ unreadCount: -1 }, { unreadCount: Number.NaN }, { unreadCount: 2 }]),
    ).toBe(2)
  })
})

describe('formatBadgeLabel', () => {
  it('is empty without unread messages and caps large counts', () => {
    expect(formatBadgeLabel(0)).toBe('')
    expect(formatBadgeLabel(-5)).toBe('')
    expect(formatBadgeLabel(12)).toBe('12')
    expect(formatBadgeLabel(999)).toBe('999')
    expect(formatBadgeLabel(1000)).toBe('999+')
  })
})

describe('formatBadgeTitle', () => {
  it('prefixes the count and replaces an existing prefix', () => {
    expect(formatBadgeTitle('Mail', 3)).toBe('(3) Mail')
    expect(formatBadgeTitle('(3) Mail', 5)).toBe('(5) Mail')
    expect(formatBadgeTitle('(999+) Mail', 0)).toBe('Mail')
    expect(formatBadgeTitle('Mail', 0)).toBe('Mail')
    expect(formatBadgeTitle('Mail', 1500)).toBe('(999+) Mail')
  })

  it('keeps a title that only looks like a count', () => {
    expect(formatBadgeTitle('(draft) Mail', 1)).toBe('(1) (draft) Mail')
  })
})
