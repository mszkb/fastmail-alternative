import { describe, expect, it } from 'vitest'
import {
  SEARCH_LIMITS,
  globalSearchPath,
  highlightParts,
  highlightTerms,
  parseSearchInput,
  parseSearchQuery,
  searchAccountProblem,
  searchQueryString,
} from '../src/search'

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

describe('global search (#121)', () => {
  it('reads operators from the search field', () => {
    expect(
      parseSearchInput(
        'Rechnung from:"Anna Muster" to:bob@example.org subject:Mai is:unread has:attachment after:2026/01/01 before:2026-02-01 2026',
      ),
    ).toEqual({
      q: 'Rechnung 2026',
      from: 'Anna Muster',
      to: 'bob@example.org',
      subject: 'Mai',
      unread: true,
      attachment: true,
      since: '2026-01-01',
      before: '2026-02-01',
    })
    expect(parseSearchInput('  "genaue Phrase" foo:bar ')).toEqual({ q: 'genaue Phrase foo:bar' })
    expect(parseSearchInput('from:')).toEqual({ q: 'from:' })
    expect(parseSearchInput('')).toEqual({})
  })

  it('validates the new criteria and writes them as query parameters', () => {
    expect(parseSearchQuery({ to: ' x ', unread: true, attachment: '0' })).toEqual({
      to: 'x',
      unread: true,
    })
    expect(parseSearchQuery({ unread: 'ja' })).toBe('Ungültiger Filter.')
    expect(parseSearchQuery({ attachment: false })).toMatch(/Suchbegriff/)
    expect(searchQueryString({ to: 'x', unread: true, attachment: false })).toBe('to=x&unread=1')
  })

  it('builds the request path per scope', () => {
    const query = { q: 'a b', folderId: 'f' }
    expect(globalSearchPath(query)).toBe('/api/search?q=a+b&limit=50')
    expect(globalSearchPath(query, { scope: 'account', accountId: 'A', folderId: 'F' })).toBe(
      '/api/search?q=a+b&accounts=A&limit=50',
    )
    expect(
      globalSearchPath(query, {
        scope: 'folder',
        accountId: 'A',
        folderId: 'F',
        cursor: 'c.d',
        limit: 10,
      }),
    ).toBe('/api/search?q=a+b&accounts=A&folderId=F&limit=10&cursor=c.d')
  })

  it('highlights terms without HTML', () => {
    const terms = highlightTerms({ q: 'rech 2026', subject: 'Rechnung' })
    expect(terms).toEqual(['Rechnung', 'rech', '2026'])
    expect(highlightParts('Ihre Rechnung 2026 (a+b)', terms)).toEqual([
      { text: 'Ihre ', match: false },
      { text: 'Rechnung', match: true },
      { text: ' ', match: false },
      { text: '2026', match: true },
      { text: ' (a+b)', match: false },
    ])
    expect(highlightParts('a+b', ['+'])).toEqual([
      { text: 'a', match: false },
      { text: '+', match: true },
      { text: 'b', match: false },
    ])
    expect(highlightParts('x', [])).toEqual([{ text: 'x', match: false }])
  })

  it('names account problems in German', () => {
    expect(searchAccountProblem({ status: 'ok' })).toBeNull()
    expect(searchAccountProblem({ status: 'timeout' })).toBe('Zeitüberschreitung')
    expect(searchAccountProblem({ status: 'error', code: 'DISABLED' })).toBe(
      'Konto ist deaktiviert',
    )
    expect(searchAccountProblem({ status: 'error', code: 'UNREACHABLE' })).toBe(
      'Anbieter nicht erreichbar',
    )
  })
})
