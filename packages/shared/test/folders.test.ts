import { describe, expect, it } from 'vitest'
import { detectFolderRoles, resolveFolderRoles, roleFromName } from '../src/folders'

describe('roleFromName', () => {
  it.each([
    ['Sent', '/', 'sent'],
    ['Gesendet', '/', 'sent'],
    ['Gesendete Objekte', '/', 'sent'],
    ['Sent Items', '/', 'sent'],
    ['[Gmail]/Sent Mail', '/', 'sent'],
    ['INBOX.Sent', '.', 'sent'],
    ['Papierkorb', '/', 'trash'],
    ['Gelöschte Elemente', '/', 'trash'],
    ['Deleted Items', '/', 'trash'],
    ['[Gmail]/Trash', '/', 'trash'],
    ['Entwürfe', '/', 'drafts'],
    ['INBOX/Drafts', '/', 'drafts'],
    ['Archiv', '/', 'archive'],
    ['Spam', '/', 'junk'],
    ['Junk-E-Mail', '/', 'junk'],
    ['[Gmail]/Spam', '/', 'junk'],
  ])('%s -> %s', (path, delimiter, role) => {
    expect(roleFromName(path, delimiter)).toBe(role)
  })

  it('handles decomposed umlauts and ignores unknown names', () => {
    expect(roleFromName('Entwürfe', '/')).toBe('drafts')
    expect(roleFromName('Projekte', '/')).toBeNull()
    expect(roleFromName('Sent/Projekte', '/')).toBeNull()
  })
})

describe('detectFolderRoles', () => {
  it('prefers SPECIAL-USE attributes over names', () => {
    const roles = detectFolderRoles([
      { path: 'INBOX', delimiter: '/' },
      { path: 'Gesendet', delimiter: '/' },
      { path: 'Sent Mail', delimiter: '/', specialUseAttribute: '\\Sent' },
      { path: 'Papierkorb', delimiter: '/' },
      { path: 'Odd', delimiter: '/', specialUseAttribute: '\\Flagged' },
    ])
    expect(Object.fromEntries(roles)).toEqual({
      INBOX: 'inbox',
      Gesendet: null,
      'Sent Mail': 'sent',
      Papierkorb: 'trash',
      Odd: null,
    })
  })
})

describe('resolveFolderRoles', () => {
  it('assigns each role to exactly one folder (shortest path first)', () => {
    const roles = resolveFolderRoles([
      { path: 'INBOX.Trash', detected: 'trash', override: null },
      { path: 'Trash', detected: 'trash', override: null },
      { path: 'INBOX', detected: 'inbox', override: null },
    ])
    expect(Object.fromEntries(roles)).toEqual({
      'INBOX.Trash': null,
      Trash: 'trash',
      INBOX: 'inbox',
    })
  })

  it('manual overrides win over detection', () => {
    const roles = resolveFolderRoles([
      { path: 'Sent', detected: 'sent', override: null },
      { path: 'Gesendet', detected: null, override: 'sent' },
      { path: 'Archiv', detected: 'archive', override: 'junk' },
    ])
    expect(Object.fromEntries(roles)).toEqual({ Sent: null, Gesendet: 'sent', Archiv: 'junk' })
  })

  it('never assigns roles to INBOX other than inbox and ignores unknown values', () => {
    const roles = resolveFolderRoles([
      { path: 'INBOX', detected: 'inbox', override: 'sent' },
      { path: 'X', detected: 'flagged', override: 'bogus' },
    ])
    expect(Object.fromEntries(roles)).toEqual({ INBOX: 'inbox', X: null })
  })
})
