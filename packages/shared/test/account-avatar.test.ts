import { describe, expect, it } from 'vitest'
import {
  ACCOUNT_COLORS,
  accountColor,
  accountInitials,
  contrastRatio,
  moveId,
  reorderIds,
} from '../src/account-avatar'

describe('accountInitials', () => {
  it('takes the first letters of two words, else two letters of one', () => {
    expect(accountInitials('Martin Schmidt')).toBe('MS')
    expect(accountInitials('  martin   schmidt  ')).toBe('MS')
    expect(accountInitials('Privat')).toBe('PR')
    expect(accountInitials('Arbeit 1791')).toBe('A1')
    expect(accountInitials('Österreich Büro')).toBe('ÖB')
    expect(accountInitials('Ä')).toBe('Ä')
  })

  it('falls back to the address and never returns an empty string', () => {
    expect(accountInitials('', 'max.mustermann@example.org')).toBe('MM')
    expect(accountInitials('', 'info@example.org')).toBe('IN')
    expect(accountInitials('(Work)')).toBe('WO')
    expect(accountInitials('', '')).toBe('?')
    expect(accountInitials('---')).toBe('?')
  })
})

describe('accountColor', () => {
  it('is stable per id and spreads over the palette', () => {
    expect(accountColor('3f2b1c00-0000-4000-8000-000000000001')).toBe(
      accountColor('3f2b1c00-0000-4000-8000-000000000001'),
    )
    const used = new Set(
      Array.from({ length: 64 }, (_, i) =>
        accountColor(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`),
      ),
    )
    expect(used.size).toBeGreaterThan(4)
    for (const color of used) expect(ACCOUNT_COLORS).toContain(color)
  })

  it('keeps white initials readable (WCAG AA) on every palette color', () => {
    for (const color of ACCOUNT_COLORS) {
      expect(contrastRatio(color, '#ffffff'), color).toBeGreaterThanOrEqual(4.5)
    }
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0)
  })
})

describe('reordering', () => {
  const ids = ['a', 'b', 'c', 'd']

  it('moves an account to the drop target', () => {
    expect(reorderIds(ids, 'a', 'c')).toEqual(['b', 'c', 'a', 'd'])
    expect(reorderIds(ids, 'd', 'a')).toEqual(['d', 'a', 'b', 'c'])
    expect(reorderIds(ids, 'b', 'b')).toEqual(ids)
    expect(reorderIds(ids, 'x', 'a')).toEqual(ids)
  })

  it('moves one step with the keyboard', () => {
    expect(moveId(ids, 'b', -1)).toEqual(['b', 'a', 'c', 'd'])
    expect(moveId(ids, 'b', 1)).toEqual(['a', 'c', 'b', 'd'])
    expect(moveId(ids, 'a', -1)).toEqual(ids)
    expect(moveId(ids, 'd', 1)).toEqual(ids)
  })
})
