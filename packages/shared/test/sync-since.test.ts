import { describe, expect, it } from 'vitest'
import { isoDay, parseSyncSince, syncSinceFromDays, utcMidnight } from '../src'

describe('sync limit (syncSince)', () => {
  const now = new Date('2026-10-04T10:00:00Z')

  it('accepts null and calendar days up to today (plus one day of slack)', () => {
    expect(parseSyncSince(null, now)).toBeNull()
    expect(parseSyncSince('2026-10-04', now)).toBe('2026-10-04')
    expect(parseSyncSince('2026-10-05', now)).toBe('2026-10-05')
    expect(parseSyncSince('1970-01-01', now)).toBe('1970-01-01')
  })

  it('rejects future days, impossible days and other formats', () => {
    for (const value of ['2026-10-06', '2026-02-30', '1969-12-31', '04.10.2026', '', 30, true]) {
      expect(parseSyncSince(value, now)).toBeUndefined()
    }
    expect(parseSyncSince(undefined, now)).toBeUndefined()
  })

  it('converts a period in days to a UTC day', () => {
    expect(syncSinceFromDays(30, now)).toBe('2026-09-04')
    expect(syncSinceFromDays(365, now)).toBe('2025-10-04')
  })

  it('converts a day to UTC midnight and back', () => {
    expect(utcMidnight('2026-01-15').toISOString()).toBe('2026-01-15T00:00:00.000Z')
    expect(isoDay(utcMidnight('2026-12-31'))).toBe('2026-12-31')
    expect(utcMidnight(null)).toBeNull()
  })
})
