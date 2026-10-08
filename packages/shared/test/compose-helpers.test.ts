import { describe, expect, it } from 'vitest'
import {
  applyRecipientSuggestion,
  currentRecipientToken,
  parseUndoSendSeconds,
  suggestRecipients,
  uniquePeople,
} from '../src/compose-helpers'

const people = uniquePeople([
  { name: 'Anna Berger', address: 'anna@example.org' },
  { name: '', address: 'ANNA@example.org' },
  { name: 'Bernd Anders', address: 'bernd@example.org' },
  { name: '', address: 'carla@firma.de' },
  null,
])

describe('recipient suggestions', () => {
  it('dedupes known people by address', () => {
    expect(people.map((p) => p.address)).toEqual([
      'anna@example.org',
      'bernd@example.org',
      'carla@firma.de',
    ])
  })

  it('matches the entry being typed against addresses and name words', () => {
    expect(currentRecipientToken('a@b.de, An')).toBe('An')
    expect(suggestRecipients('an', people).map((p) => p.address)).toEqual([
      'anna@example.org',
      'bernd@example.org',
    ])
    expect(suggestRecipients('car', people).map((p) => p.address)).toEqual(['carla@firma.de'])
    expect(suggestRecipients('a', people)).toEqual([])
    // Already in the field: not suggested again.
    expect(
      suggestRecipients('Anna Berger <anna@example.org>, an', people).map((p) => p.address),
    ).toEqual(['bernd@example.org'])
  })

  it('replaces the typed entry with the chosen person', () => {
    expect(applyRecipientSuggestion('an', people[0]!)).toBe('Anna Berger <anna@example.org>, ')
    expect(applyRecipientSuggestion('x@y.de,  car', people[2]!)).toBe('x@y.de, carla@firma.de, ')
    expect(applyRecipientSuggestion('b', { name: 'Müller, Hans', address: 'h@m.de' })).toBe(
      '"Müller, Hans" <h@m.de>, ',
    )
  })

  it('keeps separators inside a quoted name in the typed entry', () => {
    const hans = { name: 'Müller, Hans', address: 'h@m.de' }
    expect(currentRecipientToken('a@b.de, "Müller, Ha')).toBe('Müller, Ha')
    expect(suggestRecipients('a@b.de, "Müller, Ha', [hans])).toEqual([hans])
    expect(applyRecipientSuggestion('a@b.de, "Müller, Ha', hans)).toBe(
      'a@b.de, "Müller, Hans" <h@m.de>, ',
    )
  })
})

describe('undo send', () => {
  it('accepts the offered windows and defaults to 5 s', () => {
    expect(parseUndoSendSeconds('0')).toBe(0)
    expect(parseUndoSendSeconds(20)).toBe(20)
    expect(parseUndoSendSeconds('7')).toBe(5)
    expect(parseUndoSendSeconds(null)).toBe(5)
  })
})
