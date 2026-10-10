import { describe, expect, it } from 'vitest'
import type { MessageDetail, MessageListItem } from '../src/mail'
import { searchOffline, type OfflineFolder, type OfflineListEntry } from '../src/offline-search'
import { parseSearchInput } from '../src/search'

function item(id: string, over: Partial<MessageListItem> = {}): MessageListItem {
  return {
    id,
    subject: `Betreff ${id}`,
    from: { name: 'Anna Muster', address: 'anna@example.org' },
    date: '2026-10-01T10:00:00.000Z',
    snippet: 'Kurze Vorschau',
    flags: { seen: true, flagged: false, answered: false, draft: false },
    hasAttachments: false,
    threadId: null,
    threadCount: 1,
    ...over,
  } as MessageListItem
}

function entry(
  id: string,
  over: Partial<MessageListItem> = {},
  folderId = 'inbox-a',
  folderRole: string | null = 'inbox',
  accountId = 'acc-a',
): OfflineListEntry {
  return { accountId, folderId, folderRole, message: item(id, over) }
}

function detail(id: string, over: Partial<MessageDetail> = {}): MessageDetail {
  return {
    ...item(id),
    accountId: 'acc-a',
    folderIds: ['inbox-a'],
    to: [{ name: 'Bernd', address: 'bernd@example.net' }],
    cc: [],
    replyTo: [],
    deliveredTo: [],
    messageId: null,
    references: [],
    text: 'Der Text erwähnt das Projekt Zebra.',
    ...over,
  } as MessageDetail
}

const folders = new Map<string, OfflineFolder>([
  ['inbox-a', { accountId: 'acc-a', role: 'inbox' }],
  ['trash-a', { accountId: 'acc-a', role: 'trash' }],
  ['all-a', { accountId: 'acc-a', role: 'all' }],
  ['inbox-b', { accountId: 'acc-b', role: 'inbox' }],
])

const ids = (hits: { id: string | null }[]): (string | null)[] => hits.map((h) => h.id)

describe('offline search (#162)', () => {
  it('free text: subject, sender, preview and the text of opened mails, case-insensitive', () => {
    const lists = [
      entry('1', { subject: 'Rechnung Oktober' }),
      entry('2', { from: { name: 'Zoe', address: 'ZOE@shop.example' } }),
      entry('3', { snippet: 'Die Rechnung liegt bei' }),
      entry('4'),
    ]
    const details = [detail('4', { text: 'Anbei die RECHNUNG.' })]
    expect(ids(searchOffline(lists, details, folders, parseSearchInput('rechnung')))).toEqual([
      '1',
      '3',
      '4',
    ])
    expect(ids(searchOffline(lists, details, folders, parseSearchInput('zoe@shop')))).toEqual(['2'])
    // Every word must match somewhere.
    expect(ids(searchOffline(lists, details, folders, { q: 'rechnung oktober' }))).toEqual(['1'])
  })

  it('operators work like online', () => {
    const lists = [
      entry('1', { date: '2026-09-30T23:00:00.000Z', hasAttachments: true }),
      entry('2', {
        date: '2026-10-05T08:00:00.000Z',
        flags: { seen: false, flagged: false, answered: false, draft: false },
      } as Partial<MessageListItem>),
      entry('3', { subject: 'Urlaub', from: { name: 'Carl', address: 'carl@example.com' } }),
    ]
    const details = [detail('1', { to: [{ name: 'Dora', address: 'dora@example.de' }] })]
    const run = (text: string): (string | null)[] =>
      ids(searchOffline(lists, details, folders, parseSearchInput(text)))
    expect(run('from:carl')).toEqual(['3'])
    expect(run('from:"Anna Muster"')).toEqual(['2', '1'])
    expect(run('subject:urlaub')).toEqual(['3'])
    expect(run('to:dora')).toEqual(['1'])
    expect(run('is:unread')).toEqual(['2'])
    expect(run('has:attachment')).toEqual(['1'])
    expect(run('after:2026-10-01')).toEqual(['2', '3'])
    expect(run('before:2026-10-01')).toEqual(['1'])
    expect(run('after:2026-10-02 before:2026-10-06 from:anna')).toEqual(['2'])
  })

  it('newest first, one hit per message, opened mails without list entry count too', () => {
    const lists = [
      entry('1', { date: '2026-10-01T00:00:00.000Z' }, 'all-a', 'all'),
      entry('1', { date: '2026-10-01T00:00:00.000Z' }),
      entry('2', { date: '2026-10-03T00:00:00.000Z' }),
    ]
    const details = [detail('9', { date: '2026-10-02T00:00:00.000Z', subject: 'Nur geöffnet' })]
    const hits = searchOffline(lists, details, folders, { q: 'e' })
    expect(ids(hits)).toEqual(['2', '9', '1'])
    expect(hits.find((h) => h.id === '1')?.folderId).toBe('inbox-a')
    expect(hits.find((h) => h.id === '9')?.snippet).toBe('Der Text erwähnt das Projekt Zebra.')
    expect(hits.every((h) => h.synced)).toBe(true)
  })

  it('leaves out Spam and Trash unless asked, honours account and folder scope and the limit', () => {
    const lists = [
      entry('1', {}, 'trash-a', 'trash'),
      entry('2'),
      entry('3', {}, 'inbox-b', 'inbox', 'acc-b'),
    ]
    expect(ids(searchOffline(lists, [], folders, { q: 'betreff' }))).toEqual(['2', '3'])
    expect(ids(searchOffline(lists, [], folders, { q: 'betreff', includeJunk: true }))).toEqual([
      '1',
      '2',
      '3',
    ])
    expect(
      ids(searchOffline(lists, [], folders, { q: 'betreff' }, { accountIds: ['acc-b'] })),
    ).toEqual(['3'])
    expect(ids(searchOffline(lists, [], folders, { q: 'betreff', folderId: 'trash-a' }))).toEqual([
      '1',
    ])
    expect(searchOffline(lists, [], folders, { q: 'betreff' }, { limit: 1 })).toHaveLength(1)
  })

  it('an opened mail in the searched folder is found there', () => {
    const lists = [entry('1')]
    const details = [detail('1', { folderIds: ['inbox-a', 'all-a'] })]
    const hits = searchOffline(lists, details, folders, { q: 'zebra', folderId: 'all-a' })
    expect(hits.map((h) => h.folderId)).toEqual(['all-a'])
  })
})
