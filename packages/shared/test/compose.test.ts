import { describe, expect, it } from 'vitest'
import {
  MAX_REPLY_REFERENCES,
  createDraft,
  formatAddressList,
  formatQuoteDate,
  forwardBlock,
  forwardSubject,
  isValidMessageId,
  parseAddressList,
  pickIdentity,
  quoteLines,
  quoteMessage,
  replyRecipients,
  replyReferences,
  replySubject,
  signatureBlock,
  type ComposeIdentity,
  type ComposeOriginal,
} from '../src/compose'

const TZ = 'Europe/Berlin'

const identities: ComposeIdentity[] = [
  {
    id: 'id-main',
    name: 'Martin',
    emailAddress: 'me@example.com',
    signature: 'Martin\nTel. 123',
    isDefault: true,
  },
  {
    id: 'id-alias',
    name: 'Info',
    emailAddress: 'Info@Example.com',
    signature: null,
    isDefault: false,
  },
]

function original(overrides: Partial<ComposeOriginal> = {}): ComposeOriginal {
  return {
    subject: 'Angebot',
    from: { name: 'Anna Sender', address: 'anna@example.org' },
    to: [{ name: 'Martin', address: 'me@example.com' }],
    cc: [],
    replyTo: [],
    date: '2026-10-03T12:05:00.000Z',
    text: 'Hallo,\n\nanbei das Angebot.\n\nGruß Anna',
    messageId: '<orig-1@example.org>',
    references: ['<root@example.org>', '<mid@example.org>'],
    ...overrides,
  }
}

describe('replySubject', () => {
  it.each([
    ['Angebot', 'Re: Angebot'],
    ['Re: Angebot', 'Re: Angebot'],
    ['RE: Angebot', 'Re: Angebot'],
    ['re:Angebot', 'Re: Angebot'],
    ['AW: Angebot', 'Re: Angebot'],
    ['Aw: Angebot', 'Re: Angebot'],
    ['Antw: Angebot', 'Re: Angebot'],
    ['SV: Angebot', 'Re: Angebot'],
    ['Re: AW: Re: Angebot', 'Re: Angebot'],
    ['Re[2]: Angebot', 'Re: Angebot'],
    ['Re (3): Angebot', 'Re: Angebot'],
    ['  Re :  Angebot  ', 'Re: Angebot'],
    ['Fwd: Angebot', 'Re: Fwd: Angebot'],
    ['WG: Angebot', 'Re: WG: Angebot'],
    ['Re: Fwd: Angebot', 'Re: Fwd: Angebot'],
    ['Fwd: Re: Angebot', 'Re: Fwd: Re: Angebot'],
    ['', 'Re:'],
    ['Re:', 'Re:'],
    ['Return policy', 'Re: Return policy'],
    ['Reise: Planung', 'Re: Reise: Planung'],
    ['Awesome: news', 'Re: Awesome: news'],
  ])('%j -> %j', (input, expected) => {
    expect(replySubject(input)).toBe(expected)
  })

  it('removes line breaks', () => {
    expect(replySubject('Angebot\r\n Teil 2')).toBe('Re: Angebot Teil 2')
  })
})

describe('forwardSubject', () => {
  it.each([
    ['Angebot', 'Fwd: Angebot'],
    ['Fwd: Angebot', 'Fwd: Angebot'],
    ['FWD: Angebot', 'Fwd: Angebot'],
    ['Fw: Angebot', 'Fwd: Angebot'],
    ['WG: Angebot', 'Fwd: Angebot'],
    ['wg: Fwd: Angebot', 'Fwd: Angebot'],
    ['Re: Angebot', 'Fwd: Re: Angebot'],
    ['AW: Angebot', 'Fwd: AW: Angebot'],
    ['', 'Fwd:'],
    ['Fwdx: Angebot', 'Fwd: Fwdx: Angebot'],
  ])('%j -> %j', (input, expected) => {
    expect(forwardSubject(input)).toBe(expected)
  })
})

describe('isValidMessageId', () => {
  it('accepts <local@domain>', () => {
    expect(isValidMessageId('<abc.123@example.org>')).toBe(true)
  })
  it.each(['abc@example.org', '<abc>', '<a b@c>', '<a@b> <c@d>', '', null, 42])(
    'rejects %j',
    (value) => {
      expect(isValidMessageId(value)).toBe(false)
    },
  )
  it('rejects overly long ids', () => {
    expect(isValidMessageId(`<${'a'.repeat(250)}@example.org>`)).toBe(false)
  })
})

describe('replyReferences', () => {
  it('appends the Message-ID to the References', () => {
    expect(replyReferences(original())).toEqual([
      '<root@example.org>',
      '<mid@example.org>',
      '<orig-1@example.org>',
    ])
  })

  it('works without References', () => {
    expect(replyReferences(original({ references: [] }))).toEqual(['<orig-1@example.org>'])
  })

  it('works without Message-ID', () => {
    expect(replyReferences(original({ messageId: null }))).toEqual([
      '<root@example.org>',
      '<mid@example.org>',
    ])
  })

  it('drops invalid and duplicate ids', () => {
    expect(
      replyReferences(
        original({
          references: [
            '<root@example.org>',
            'garbage',
            '<root@example.org>',
            '<orig-1@example.org>',
          ],
        }),
      ),
    ).toEqual(['<root@example.org>', '<orig-1@example.org>'])
  })

  it('caps long chains, keeping the root and the newest ids', () => {
    const references = Array.from({ length: 50 }, (_, i) => `<r${i}@example.org>`)
    const result = replyReferences(original({ references }))
    expect(result).toHaveLength(MAX_REPLY_REFERENCES)
    expect(result[0]).toBe('<r0@example.org>')
    expect(result[result.length - 1]).toBe('<orig-1@example.org>')
    expect(result[result.length - 2]).toBe('<r49@example.org>')
    expect(result[1]).toBe(`<r${50 - (MAX_REPLY_REFERENCES - 2)}@example.org>`)
  })
})

describe('replyRecipients', () => {
  const own = ['me@example.com', 'Info@Example.com']

  it('replies to From', () => {
    expect(replyRecipients(original(), own, false)).toEqual({
      to: [{ name: 'Anna Sender', address: 'anna@example.org' }],
      cc: [],
    })
  })

  it('prefers Reply-To over From', () => {
    const result = replyRecipients(
      original({ replyTo: [{ name: 'List', address: 'list@example.org' }] }),
      own,
      false,
    )
    expect(result.to).toEqual([{ name: 'List', address: 'list@example.org' }])
  })

  it('returns no recipients without From and Reply-To', () => {
    expect(replyRecipients(original({ from: null }), own, false)).toEqual({ to: [], cc: [] })
  })

  it('reply all: Reply-To/From plus To, Cc stays Cc, own addresses removed', () => {
    const result = replyRecipients(
      original({
        to: [
          { name: 'Martin', address: 'ME@example.com' },
          { name: 'Bob', address: 'bob@example.org' },
        ],
        cc: [
          { name: 'Info', address: 'info@example.com' },
          { name: 'Carol', address: 'carol@example.org' },
        ],
      }),
      own,
      true,
    )
    expect(result).toEqual({
      to: [
        { name: 'Anna Sender', address: 'anna@example.org' },
        { name: 'Bob', address: 'bob@example.org' },
      ],
      cc: [{ name: 'Carol', address: 'carol@example.org' }],
    })
  })

  it('reply all: deduplicates case-insensitively across To and Cc', () => {
    const result = replyRecipients(
      original({
        to: [
          { name: '', address: 'Anna@Example.org' },
          { name: 'Bob', address: 'bob@example.org' },
          { name: 'Bob 2', address: 'BOB@example.org' },
        ],
        cc: [
          { name: '', address: 'bob@EXAMPLE.org' },
          { name: 'Carol', address: 'carol@example.org' },
          { name: '', address: 'carol@example.org' },
        ],
      }),
      own,
      true,
    )
    expect(result.to.map((p) => p.address)).toEqual(['anna@example.org', 'bob@example.org'])
    expect(result.cc.map((p) => p.address)).toEqual(['carol@example.org'])
  })

  it('reply all with Reply-To keeps From out unless it is in To/Cc', () => {
    const result = replyRecipients(
      original({ replyTo: [{ name: 'List', address: 'list@example.org' }] }),
      own,
      true,
    )
    expect(result.to.map((p) => p.address)).toEqual(['list@example.org'])
  })

  it('reply all: promotes Cc when To is empty after filtering', () => {
    const result = replyRecipients(
      original({
        from: { name: 'Me', address: 'me@example.com' },
        to: [{ name: '', address: 'info@example.com' }],
        cc: [{ name: 'Carol', address: 'carol@example.org' }],
      }),
      own,
      true,
    )
    expect(result).toEqual({ to: [{ name: 'Carol', address: 'carol@example.org' }], cc: [] })
  })

  it('replying to an own (sent) message goes to its recipients', () => {
    const sent = original({
      from: { name: 'Martin', address: 'me@example.com' },
      to: [{ name: 'Bob', address: 'bob@example.org' }],
      cc: [{ name: 'Carol', address: 'carol@example.org' }],
    })
    expect(replyRecipients(sent, own, false)).toEqual({
      to: [{ name: 'Bob', address: 'bob@example.org' }],
      cc: [],
    })
    expect(replyRecipients(sent, own, true)).toEqual({
      to: [{ name: 'Bob', address: 'bob@example.org' }],
      cc: [{ name: 'Carol', address: 'carol@example.org' }],
    })
  })

  it('note to self: reply to an own message sent to oneself', () => {
    const self = original({
      from: { name: 'Martin', address: 'me@example.com' },
      to: [{ name: 'Martin', address: 'me@example.com' }],
    })
    expect(replyRecipients(self, own, false).to).toEqual([
      { name: 'Martin', address: 'me@example.com' },
    ])
  })
})

describe('quote', () => {
  it('formats the date in German', () => {
    expect(formatQuoteDate('2026-10-03T12:05:00.000Z', TZ)).toBe('03.10.2026 um 14:05')
    expect(formatQuoteDate('not a date', TZ)).toBe('')
  })

  it('prefixes lines with "> " and empty lines with ">"', () => {
    expect(quoteLines('a\n\nb')).toBe('> a\n>\n> b')
  })

  it('nests existing quotes and normalizes CRLF', () => {
    expect(quoteLines('> old\r\nnew\r\n')).toBe('> > old\n> new')
  })

  it('trims trailing whitespace and handles empty text', () => {
    expect(quoteLines('text  \n\n\n')).toBe('> text')
    expect(quoteLines('')).toBe('')
    expect(quoteLines('  \n ')).toBe('')
  })

  it('adds an attribution line', () => {
    expect(quoteMessage(original({ text: 'Hallo\nWelt' }), TZ)).toBe(
      'Am 03.10.2026 um 14:05 schrieb Anna Sender <anna@example.org>:\n> Hallo\n> Welt',
    )
  })

  it('uses the address without a name, and works without text or date', () => {
    expect(quoteMessage(original({ from: { name: '', address: 'a@b.de' }, text: null }), TZ)).toBe(
      'Am 03.10.2026 um 14:05 schrieb a@b.de:',
    )
    expect(quoteMessage(original({ from: null, date: '', text: 'x' }), TZ)).toBe(
      'Unbekannt schrieb:\n> x',
    )
  })
})

describe('signatureBlock', () => {
  it('prepends the "-- " delimiter', () => {
    expect(signatureBlock('Martin\nTel. 123')).toBe('-- \nMartin\nTel. 123')
  })

  it('is empty without a signature', () => {
    expect(signatureBlock(null)).toBe('')
    expect(signatureBlock(undefined)).toBe('')
    expect(signatureBlock('  \n ')).toBe('')
  })

  it('does not double an existing delimiter', () => {
    expect(signatureBlock('-- \nMartin')).toBe('-- \nMartin')
    expect(signatureBlock('--\nMartin')).toBe('-- \nMartin')
  })

  it('normalizes CRLF and trims trailing whitespace', () => {
    expect(signatureBlock('Martin\r\nTel\r\n\r\n')).toBe('-- \nMartin\nTel')
  })
})

describe('forwardBlock', () => {
  it('lists Von/Datum/Betreff/An/Cc and the original text', () => {
    const block = forwardBlock(
      original({
        to: [
          { name: 'Martin', address: 'me@example.com' },
          { name: '', address: 'bob@example.org' },
        ],
        cc: [{ name: 'Carol', address: 'carol@example.org' }],
        text: 'Inhalt\r\n',
      }),
      TZ,
    )
    expect(block).toBe(
      [
        '-------- Weitergeleitete Nachricht --------',
        'Von: Anna Sender <anna@example.org>',
        'Datum: 03.10.2026 um 14:05',
        'Betreff: Angebot',
        'An: Martin <me@example.com>, bob@example.org',
        'Cc: Carol <carol@example.org>',
        '',
        'Inhalt',
      ].join('\n'),
    )
  })

  it('omits empty Cc and text', () => {
    const block = forwardBlock(original({ text: null }), TZ)
    expect(block).not.toContain('Cc:')
    expect(block.endsWith('An: Martin <me@example.com>')).toBe(true)
  })
})

describe('pickIdentity', () => {
  it('uses the identity the original was addressed to', () => {
    const picked = pickIdentity(
      identities,
      original({ to: [], cc: [{ name: '', address: 'info@example.com' }] }),
    )
    expect(picked?.id).toBe('id-alias')
  })

  it('falls back to the default identity, then the first', () => {
    expect(pickIdentity(identities, original({ to: [] }))?.id).toBe('id-main')
    expect(pickIdentity([{ ...identities[1]! }])?.id).toBe('id-alias')
    expect(pickIdentity([])).toBeNull()
  })
})

describe('createDraft', () => {
  it('new message: default identity and signature only', () => {
    const draft = createDraft('new', identities)
    expect(draft).toEqual({
      mode: 'new',
      identityId: 'id-main',
      to: [],
      cc: [],
      bcc: [],
      subject: '',
      text: '\n\n-- \nMartin\nTel. 123',
    })
  })

  it('new message without signature has an empty body', () => {
    expect(createDraft('new', [identities[1]!]).text).toBe('')
  })

  it('reply: headers, signature above the quote', () => {
    const draft = createDraft('reply', identities, original({ text: 'Hallo' }), TZ)
    expect(draft.to).toEqual([{ name: 'Anna Sender', address: 'anna@example.org' }])
    expect(draft.cc).toEqual([])
    expect(draft.subject).toBe('Re: Angebot')
    expect(draft.inReplyTo).toBe('<orig-1@example.org>')
    expect(draft.references).toEqual([
      '<root@example.org>',
      '<mid@example.org>',
      '<orig-1@example.org>',
    ])
    expect(draft.text).toBe(
      '\n\n-- \nMartin\nTel. 123\n\nAm 03.10.2026 um 14:05 schrieb Anna Sender <anna@example.org>:\n> Hallo',
    )
    expect(draft.text.indexOf('-- \n')).toBeLessThan(draft.text.indexOf('schrieb'))
  })

  it('reply without signature or Message-ID', () => {
    const draft = createDraft(
      'reply',
      [identities[1]!],
      original({ text: 'Hallo', messageId: null, references: [] }),
      TZ,
    )
    expect(draft.inReplyTo).toBeUndefined()
    expect(draft.references).toBeUndefined()
    expect(draft.text).toBe(
      '\n\nAm 03.10.2026 um 14:05 schrieb Anna Sender <anna@example.org>:\n> Hallo',
    )
  })

  it('reply all: own addresses of all identities removed', () => {
    const draft = createDraft(
      'replyAll',
      identities,
      original({
        to: [
          { name: 'Martin', address: 'me@example.com' },
          { name: 'Bob', address: 'bob@example.org' },
        ],
        cc: [{ name: 'Info', address: 'INFO@example.com' }],
      }),
      TZ,
    )
    expect(draft.to.map((p) => p.address)).toEqual(['anna@example.org', 'bob@example.org'])
    expect(draft.cc).toEqual([])
    expect(draft.identityId).toBe('id-main')
  })

  it('forward: Fwd subject, no recipients, no In-Reply-To, forwarded block', () => {
    const draft = createDraft('forward', identities, original({ subject: 'AW: Angebot' }), TZ)
    expect(draft.subject).toBe('Fwd: AW: Angebot')
    expect(draft.to).toEqual([])
    expect(draft.inReplyTo).toBeUndefined()
    expect(draft.references).toContain('<orig-1@example.org>')
    expect(draft.text.startsWith('\n\n-- \nMartin\nTel. 123\n\n-------- Weitergeleitete')).toBe(
      true,
    )
    expect(draft.text).toContain('Betreff: AW: Angebot')
    expect(draft.text).toContain('anbei das Angebot.')
    expect(draft.text).not.toContain('> ')
  })

  it('falls back to a new message without an original', () => {
    expect(createDraft('reply', identities).mode).toBe('new')
  })
})

describe('address lists', () => {
  it('parses plain, named and quoted entries separated by , or ;', () => {
    const result = parseAddressList(
      'a@example.org, Bob <bob@example.org>; "Doe, John" <john@example.org>,, ',
    )
    expect(result.invalid).toEqual([])
    expect(result.people).toEqual([
      { name: '', address: 'a@example.org' },
      { name: 'Bob', address: 'bob@example.org' },
      { name: 'Doe, John', address: 'john@example.org' },
    ])
  })

  it('reports invalid entries', () => {
    const result = parseAddressList('ok@example.org, nope, Bob <bob@>, a b@example.org')
    expect(result.people).toEqual([{ name: '', address: 'ok@example.org' }])
    expect(result.invalid).toEqual(['nope', 'Bob <bob@>', 'a b@example.org'])
  })

  it('handles escaped quotes in names', () => {
    expect(parseAddressList('"Say \\"Hi\\"" <hi@example.org>').people).toEqual([
      { name: 'Say "Hi"', address: 'hi@example.org' },
    ])
  })

  it('returns nothing for empty input', () => {
    expect(parseAddressList('  ')).toEqual({ people: [], invalid: [] })
  })

  it('formats lists and round-trips through the parser', () => {
    const people = [
      { name: '', address: 'a@example.org' },
      { name: 'Bob', address: 'bob@example.org' },
      { name: 'Doe, John', address: 'john@example.org' },
      { name: 'Say "Hi"', address: 'hi@example.org' },
    ]
    const text = formatAddressList(people)
    expect(text).toBe(
      'a@example.org, Bob <bob@example.org>, "Doe, John" <john@example.org>, "Say \\"Hi\\"" <hi@example.org>',
    )
    expect(parseAddressList(text)).toEqual({ people, invalid: [] })
  })
})
