import { describe, expect, it } from 'vitest'
import { SEARCH_LIMITS, parseSearchQuery, searchQueryString } from '../src/search'

describe('parseSearchQuery', () => {
  it('normalizes text criteria and drops empty ones', () => {
    expect(parseSearchQuery({ q: '  Rechnung\r\n2026 ', from: '', subject: undefined })).toEqual({
      q: 'Rechnung 2026',
    })
  })

  it('accepts date ranges and a folder', () => {
    const folderId = '0b7f5e1c-3f43-4c9c-9b0e-2c8f1d3a4b5c'
    expect(parseSearchQuery({ since: '2026-01-01', before: '2026-02-01', folderId })).toEqual({
      since: '2026-01-01',
      before: '2026-02-01',
      folderId,
    })
  })

  it('rejects invalid input with a German message', () => {
    expect(parseSearchQuery({})).toMatch(/Suchbegriff/)
    expect(parseSearchQuery({ q: '   ' })).toMatch(/Suchbegriff/)
    expect(parseSearchQuery({ q: 'x'.repeat(SEARCH_LIMITS.maxTermLength + 1) })).toMatch(/lang/)
    expect(parseSearchQuery({ since: '2026-02-30' })).toBe('Ungültiges Datum.')
    expect(parseSearchQuery({ since: '1.1.2026' })).toBe('Ungültiges Datum.')
    expect(parseSearchQuery({ since: '2026-02-01', before: '2026-02-01' })).toMatch(/leer/)
    expect(parseSearchQuery({ q: 'x', folderId: 'inbox' })).toBe('Ungültiger Ordner.')
    expect(parseSearchQuery({ q: ['a', 'b'] })).toBe('Ungültiger Suchbegriff.')
  })

  it('builds the query string without empty criteria', () => {
    expect(searchQueryString({ q: 'a b', subject: '', since: '2026-01-01' })).toBe(
      'q=a+b&since=2026-01-01',
    )
  })
})
