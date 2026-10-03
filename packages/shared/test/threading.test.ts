import { describe, expect, it } from 'vitest'
import { baseSubject, hasReplyPrefix } from '../src/compose'
import {
  SUBJECT_THREAD_WINDOW_MS,
  groupThreads,
  threadLinks,
  threadSubjectKey,
  type ThreadingMessage,
} from '../src/threading'

const DAY = 24 * 60 * 60 * 1000
const T0 = Date.UTC(2026, 8, 1, 9, 0, 0)

/** Corpus helper: a message as the sync stores it (subject -> key + reply flag). */
function mail(
  id: string,
  subject: string,
  day: number,
  headers: { messageId?: string | null; inReplyTo?: string; references?: string[] } = {},
): ThreadingMessage {
  return {
    id,
    messageId: headers.messageId === undefined ? `<${id}@example.org>` : headers.messageId,
    inReplyTo: headers.inReplyTo ?? null,
    references: headers.references ?? [],
    subjectKey: threadSubjectKey(subject),
    isReply: hasReplyPrefix(subject),
    date: T0 + day * DAY,
  }
}

const mid = (id: string): string => `<${id}@example.org>`

/** Thread partition as sorted lists of sorted ids (order independent). */
function partition(messages: ThreadingMessage[]): string[][] {
  return groupThreads(messages)
    .map((group) => [...group].sort())
    .sort((a, b) => a[0]!.localeCompare(b[0]!))
}

/** Deterministic shuffle (arrival order must not matter). */
function shuffled<T>(items: T[], seed: number): T[] {
  const result = [...items]
  let state = seed
  for (let i = result.length - 1; i > 0; i -= 1) {
    state = (state * 1103515245 + 12345) % 2 ** 31
    const j = state % (i + 1)
    ;[result[i], result[j]] = [result[j]!, result[i]!]
  }
  return result
}

/**
 * Standard test corpus (roadmap 2.5 acceptance): one account's mailbox
 * with the usual threading situations.
 */
const corpus: ThreadingMessage[] = [
  // A: plain reply chain with full References, plus a reply-all branch.
  mail('a1', 'Projektstart', 0),
  mail('a2', 'Re: Projektstart', 1, { inReplyTo: mid('a1'), references: [mid('a1')] }),
  mail('a3', 'Re: Projektstart', 2, {
    inReplyTo: mid('a2'),
    references: [mid('a1'), mid('a2')],
  }),
  mail('a4', 'AW: Projektstart', 2, {
    // reply-all to a1 from another participant (branch)
    inReplyTo: mid('a1'),
    references: [mid('a1')],
  }),
  // A forward of a3 that keeps the references (Gmail/Outlook style).
  mail('a5', 'Fwd: Re: Projektstart', 3, {
    inReplyTo: mid('a3'),
    references: [mid('a1'), mid('a2'), mid('a3')],
  }),

  // B: In-Reply-To only (no References header, older clients).
  mail('b1', 'Urlaubsplanung', 0),
  mail('b2', 'Re: Urlaubsplanung', 4, { inReplyTo: mid('b1') }),

  // C: References only, with a missing middle message (b-phantom).
  mail('c1', 'Server-Umzug', 0),
  mail('c3', 'Re: Re: Server-Umzug', 5, { references: [mid('c1'), mid('c2-missing')] }),

  // D: two replies to a root we never received - grouped via the phantom root.
  mail('d2', 'Re: Newsletter-Frage', 1, { inReplyTo: mid('d1-missing') }),
  mail('d3', 'Re: Newsletter-Frage', 2, {
    inReplyTo: mid('d2'),
    references: [mid('d1-missing'), mid('d2')],
  }),
  mail('d4', 'Re: Newsletter-Frage', 2, { references: [mid('d1-missing')] }),

  // E: client without any reference headers: subject fallback, incl. Re: Re: chains.
  mail('e1', 'Grillfest am Samstag', 0),
  mail('e2', 'Re: Grillfest am Samstag', 1),
  mail('e3', 'RE: re: Grillfest am  Samstag', 2),
  mail('e4', 'Aw: Grillfest am Samstag', 3),

  // F: subject collisions of unrelated mails (no reply prefix): separate threads.
  mail('f1', 'Ihre Rechnung', 0),
  mail('f2', 'Ihre Rechnung', 10),
  mail('f3', 'Ihre Rechnung', 20),

  // G: reply without references outside the subject window: new thread.
  mail('g1', 'Quartalsbericht', 0),
  mail('g2', 'Re: Quartalsbericht', 45),

  // H: a forward without reference headers starts its own conversation.
  mail('h1', 'Angebot', 0),
  mail('h2', 'Fwd: Angebot', 1),

  // I: same subject as A, but referencing nothing in A: references win, the
  // subject is ignored for messages with reference headers.
  mail('i1', 'Re: Projektstart', 2, { inReplyTo: mid('elsewhere') }),

  // J: subject-only reply without Message-ID and without any original: alone.
  mail('j1', 'Re: Ohne Message-ID', 0, { messageId: null }),
]

const expected = [
  ['a1', 'a2', 'a3', 'a4', 'a5'],
  ['b1', 'b2'],
  ['c1', 'c3'],
  ['d2', 'd3', 'd4'],
  ['e1', 'e2', 'e3', 'e4'],
  ['f1'],
  ['f2'],
  ['f3'],
  ['g1'],
  ['g2'],
  ['h1'],
  ['h2'],
  ['i1'],
  ['j1'],
]

describe('subject normalization', () => {
  it('strips interleaved reply and forward prefixes', () => {
    expect(baseSubject('Re: AW: Fwd: WG: Termin')).toBe('Termin')
    expect(baseSubject('Re[2]: Re(3):  Termin \r\n morgen')).toBe('Termin morgen')
    expect(baseSubject('Termin: Re: morgen')).toBe('Termin: Re: morgen')
  })

  it('builds case-insensitive keys, null for empty subjects', () => {
    expect(threadSubjectKey('RE: Grillfest')).toBe(threadSubjectKey('grillfest'))
    expect(threadSubjectKey('Re: ')).toBeNull()
    expect(threadSubjectKey('')).toBeNull()
  })

  it('detects reply prefixes only at the start', () => {
    expect(hasReplyPrefix('Re: x')).toBe(true)
    expect(hasReplyPrefix('AW: x')).toBe(true)
    expect(hasReplyPrefix('Fwd: Re: x')).toBe(false)
    expect(hasReplyPrefix('Report')).toBe(false)
  })
})

describe('threadLinks', () => {
  it('merges In-Reply-To and References without duplicates or the own id', () => {
    expect(
      threadLinks({
        messageId: '<self@x>',
        inReplyTo: '<b@x>',
        references: ['<a@x>', '<b@x>', '<self@x>'],
      }),
    ).toEqual(['<a@x>', '<b@x>'])
  })
})

describe('groupThreads on the standard corpus', () => {
  it('builds the expected threads', () => {
    expect(partition(corpus)).toEqual(expected)
  })

  it('does not depend on the arrival order (child before parent)', () => {
    for (const seed of [1, 7, 42, 1234, 99991]) {
      expect(partition(shuffled(corpus, seed))).toEqual(expected)
    }
    expect(partition([...corpus].reverse())).toEqual(expected)
  })

  it('merges two partial threads once the connecting parent arrives', () => {
    const child = mail('x3', 'Re: Re: Thema', 2, {
      inReplyTo: mid('x2'),
      references: [mid('x2')],
    })
    const root = mail('x1', 'Thema', 0)
    const middle = mail('x2', 'Re: Thema', 1, { inReplyTo: mid('x1'), references: [mid('x1')] })
    expect(partition([child, root])).toEqual([['x1'], ['x3']])
    expect(partition([child, root, middle])).toEqual([['x1', 'x2', 'x3']])
  })

  it('keeps a subject-only reply with exactly one of two same-subject originals', () => {
    const groups = partition([
      mail('o1', 'Hallo', 0),
      mail('o2', 'Hallo', 5),
      mail('r1', 'Re: Hallo', 6),
    ])
    expect(groups).toEqual([['o1'], ['o2', 'r1']])
  })

  it('links an early subject-only reply to the original arriving later', () => {
    const reply = mail('r', 'Re: Spätzünder', 0)
    const original = { ...mail('o', 'Spätzünder', 0), date: reply.date! + 60_000 }
    expect(partition([reply, original])).toEqual([['o', 'r']])
  })

  it('respects the subject window', () => {
    const original = mail('w1', 'Fenster', 0)
    const inside = { ...mail('w2', 'Re: Fenster', 0), date: T0 + SUBJECT_THREAD_WINDOW_MS }
    const outside = { ...mail('w3', 'Re: Fenster', 0), date: T0 - SUBJECT_THREAD_WINDOW_MS - 1 }
    expect(partition([original, inside, outside])).toEqual([['w1', 'w2'], ['w3']])
  })

  it('groups duplicates of the same Message-ID (copies in several folders)', () => {
    const copy1 = mail('dup1', 'Kopie', 0, { messageId: '<same@x>' })
    const copy2 = mail('dup2', 'Kopie', 0, { messageId: '<same@x>' })
    expect(partition([copy1, copy2])).toEqual([['dup1', 'dup2']])
  })
})
