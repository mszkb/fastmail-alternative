import { describe, expect, it } from 'vitest'
import { PullToRefresh, manualSyncNotice } from '../src/pull-to-refresh'

describe('PullToRefresh', () => {
  it('triggers when pulled past the threshold from the top', () => {
    const pull = new PullToRefresh({ thresholdPx: 60, maxPx: 90, damping: 0.5 })
    pull.start(100, true)
    expect(pull.move(150)).toBe(25)
    expect(pull.armed).toBe(false)
    expect(pull.move(230)).toBe(65)
    expect(pull.armed).toBe(true)
    expect(pull.end()).toBe(true)
    expect(pull.distance).toBe(0)
  })

  it('caps the distance and ignores upward movement', () => {
    const pull = new PullToRefresh({ thresholdPx: 60, maxPx: 90, damping: 0.5 })
    pull.start(0, true)
    expect(pull.move(1000)).toBe(90)
    expect(pull.move(-50)).toBe(0)
    expect(pull.end()).toBe(false)
  })

  it('does not trigger below the threshold', () => {
    const pull = new PullToRefresh()
    pull.start(0, true)
    pull.move(100)
    expect(pull.end()).toBe(false)
  })

  it('does not start when the list is scrolled down', () => {
    const pull = new PullToRefresh()
    pull.start(0, false)
    expect(pull.move(500)).toBe(0)
    expect(pull.end()).toBe(false)
  })

  it('needs a new start after a release', () => {
    const pull = new PullToRefresh()
    pull.start(0, true)
    pull.end()
    expect(pull.move(500)).toBe(0)
    expect(pull.end()).toBe(false)
  })
})

describe('manualSyncNotice', () => {
  it('stays quiet when the sync was queued or skipped', () => {
    expect(manualSyncNotice(202)).toBeNull()
    expect(manualSyncNotice(200)).toBeNull()
  })

  it('shows rate limiting as a hint, not an error', () => {
    expect(manualSyncNotice(429)).toBe('Gerade aktualisiert.')
  })

  it('reports offline and failures', () => {
    expect(manualSyncNotice('offline')).toMatch(/Offline/)
    expect(manualSyncNotice(500)).toBe('Aktualisieren fehlgeschlagen.')
  })
})
