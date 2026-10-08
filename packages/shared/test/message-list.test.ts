import { describe, expect, it } from 'vitest'
import { dateGroup, groupByDate, selectRange } from '../src/message-list'

// Wednesday, 7 October 2026, 15:00 local time.
const now = new Date(2026, 9, 7, 15, 0)
const at = (day: number, hour = 10) => new Date(2026, 9, day, hour).toISOString()

describe('dateGroup', () => {
  it('sorts into today, yesterday, this week and older', () => {
    expect(dateGroup(at(7, 0), now)).toBe('Heute')
    expect(dateGroup(at(8), now)).toBe('Heute') // clock skew: future = today
    expect(dateGroup(at(6, 23), now)).toBe('Gestern')
    expect(dateGroup(at(5), now)).toBe('Diese Woche') // Monday
    expect(dateGroup(at(4), now)).toBe('Älter') // Sunday before
    expect(dateGroup('not a date', now)).toBe('Älter')
  })

  it('on a Monday, yesterday is not "this week"', () => {
    const monday = new Date(2026, 9, 5, 9)
    expect(dateGroup(at(4), monday)).toBe('Gestern')
    expect(dateGroup(at(3), monday)).toBe('Älter')
  })
})

describe('groupByDate', () => {
  it('builds consecutive groups in list order', () => {
    const list = [
      { id: 'a', date: at(7) },
      { id: 'b', date: at(7, 8) },
      { id: 'c', date: at(6) },
      { id: 'd', date: at(1) },
    ]
    expect(groupByDate(list, now).map((g) => [g.label, g.messages.map((m) => m.id)])).toEqual([
      ['Heute', ['a', 'b']],
      ['Gestern', ['c']],
      ['Älter', ['d']],
    ])
    expect(groupByDate([], now)).toEqual([])
  })
})

describe('selectRange', () => {
  const ids = ['a', 'b', 'c', 'd', 'e']
  it('selects between anchor and target in both directions', () => {
    expect(selectRange(ids, 'b', 'd')).toEqual(['b', 'c', 'd'])
    expect(selectRange(ids, 'd', 'b')).toEqual(['b', 'c', 'd'])
    expect(selectRange(ids, 'c', 'c')).toEqual(['c'])
    expect(selectRange(ids, '', 'c')).toEqual(['c'])
    expect(selectRange(ids, 'a', 'gone')).toEqual([])
  })
})
