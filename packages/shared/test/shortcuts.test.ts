import { describe, expect, it } from 'vitest'
import { SHORTCUTS, ShortcutMatcher, moveCursor, shortcutLabel } from '../src/shortcuts'

describe('ShortcutMatcher', () => {
  it('maps single keys, case-sensitive for Shift letters', () => {
    const m = new ShortcutMatcher()
    expect(m.handle({ key: 'j' })).toBe('next')
    expect(m.handle({ key: 'k' })).toBe('previous')
    expect(m.handle({ key: 'Enter' })).toBe('open')
    expect(m.handle({ key: 'o' })).toBe('open')
    expect(m.handle({ key: 'u' })).toBe('back')
    expect(m.handle({ key: 'Escape' })).toBe('back')
    expect(m.handle({ key: 'e' })).toBe('archive')
    expect(m.handle({ key: 'y' })).toBe('archive')
    expect(m.handle({ key: '#' })).toBe('delete')
    expect(m.handle({ key: '!' })).toBe('flag')
    expect(m.handle({ key: 'I' })).toBe('markRead')
    expect(m.handle({ key: 'U' })).toBe('markUnread')
    expect(m.handle({ key: 'c' })).toBe('compose')
    expect(m.handle({ key: '?' })).toBe('help')
    expect(m.handle({ key: 'x' })).toBeNull()
  })

  it('ignores keys with Ctrl, Cmd or Alt', () => {
    const m = new ShortcutMatcher()
    expect(m.handle({ key: 'r', ctrlKey: true })).toBeNull()
    expect(m.handle({ key: 'r', metaKey: true })).toBeNull()
    expect(m.handle({ key: 'r', altKey: true })).toBeNull()
  })

  it('handles "g" sequences within the timeout', () => {
    let now = 0
    const m = new ShortcutMatcher(1500, () => now)
    expect(m.handle({ key: 'g' })).toBe('pending')
    now = 500
    expect(m.handle({ key: 'i' })).toBe('goInbox')
    expect(m.handle({ key: 'g' })).toBe('pending')
    expect(m.handle({ key: 'x' })).toBeNull()
    // The key after an unknown sequence is a normal key again.
    expect(m.handle({ key: 'r' })).toBe('reply')
    expect(m.handle({ key: 'g' })).toBe('pending')
    now = 3000
    expect(m.handle({ key: 's' })).toBe('flag')
    m.handle({ key: 'g' })
    m.reset()
    expect(m.handle({ key: 'i' })).toBeNull()
  })

  it('has no key twice', () => {
    const keys = SHORTCUTS.flatMap((s) => s.keys)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('helpers', () => {
  it('labels keys for the overview', () => {
    expect(shortcutLabel('I')).toBe('Shift+I')
    expect(shortcutLabel('g i')).toBe('g dann i')
    expect(shortcutLabel('Escape')).toBe('Esc')
    expect(shortcutLabel('#')).toBe('#')
  })

  it('moves the cursor within the list', () => {
    const ids = ['a', 'b', 'c']
    expect(moveCursor(ids, '', 1)).toBe('a')
    expect(moveCursor(ids, 'a', 1)).toBe('b')
    expect(moveCursor(ids, 'c', 1)).toBe('c')
    expect(moveCursor(ids, 'a', -1)).toBe('a')
    expect(moveCursor(ids, 'gone', -1)).toBe('a')
    expect(moveCursor([], 'a', 1)).toBeNull()
  })
})
