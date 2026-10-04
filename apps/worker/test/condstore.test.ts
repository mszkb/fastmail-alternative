/**
 * CONDSTORE (RFC 7162, #28) in message_sync: incremental flag sync via
 * UID FETCH ... (CHANGEDSINCE n). GreenMail does not announce CONDSTORE (its
 * runs cover the full-listing fallback in message-sync.test.ts), so this
 * test uses a small fake IMAP server. Needs DATABASE_URL; skipped when unset.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import pg from 'pg'
import { runMigrations } from '@fma/db/migrate'
import { encryptField, generateDataKey, loadMasterKey, wrapDataKey } from '@fma/crypto'
import { runMessageSync } from '../src/jobs/message-sync'

process.env.MASTER_KEY ??= randomBytes(32).toString('base64')

const databaseUrl = process.env.DATABASE_URL

interface FakeMailbox {
  capabilities: string
  highestModseq: bigint | null // null: NOMODSEQ mailbox
  uids: number[]
  flags: Map<number, string[]>
  modseqs: Map<number, bigint>
}

describe.skipIf(!databaseUrl)('message_sync with CONDSTORE', () => {
  let pool: pg.Pool
  let accountId: string
  let folderId: string
  let dataDir: string
  let server: net.Server
  const sockets: net.Socket[] = []
  let commands: string[] = []
  let mailbox: FakeMailbox

  function handle(socket: net.Socket, line: string): void {
    const match = /^(\S+) (?:UID )?(\S+)(.*)$/i.exec(line)
    if (!match) return
    const [, tag, rawCommand, rest = ''] = match
    const command = rawCommand!.toUpperCase()
    commands.push(line.startsWith(`${tag} LOGIN`) ? `${tag} LOGIN` : line)
    const write = (text: string): boolean => socket.write(text)
    switch (command) {
      case 'CAPABILITY':
        write(`* CAPABILITY ${mailbox.capabilities}\r\n${tag} OK done\r\n`)
        break
      case 'LOGIN':
        write(`${tag} OK [CAPABILITY ${mailbox.capabilities}] logged in\r\n`)
        break
      case 'ENABLE': {
        const enabled = rest.toUpperCase().includes('CONDSTORE') ? ' CONDSTORE' : ''
        write(`* ENABLED${enabled}\r\n${tag} OK enabled\r\n`)
        break
      }
      case 'SELECT':
      case 'EXAMINE': {
        const modseq =
          mailbox.highestModseq === null
            ? '* OK [NOMODSEQ] no modseq\r\n'
            : `* OK [HIGHESTMODSEQ ${mailbox.highestModseq}] ok\r\n`
        write(
          `* FLAGS (\\Seen \\Flagged \\Deleted)\r\n* ${mailbox.uids.length} EXISTS\r\n` +
            `* OK [UIDVALIDITY 7] ok\r\n* OK [UIDNEXT 10] ok\r\n${modseq}` +
            `${tag} OK [READ-WRITE] selected\r\n`,
        )
        break
      }
      case 'SEARCH':
        write(`* SEARCH ${mailbox.uids.join(' ')}\r\n${tag} OK done\r\n`)
        break
      case 'FETCH': {
        const since = /CHANGEDSINCE (\d+)/i.exec(rest)
        let out = ''
        mailbox.uids.forEach((uid, index) => {
          const modseq = mailbox.modseqs.get(uid) ?? 1n
          if (since && modseq <= BigInt(since[1]!)) return
          const flags = (mailbox.flags.get(uid) ?? []).join(' ')
          const modseqPart = mailbox.highestModseq === null ? '' : ` MODSEQ (${modseq})`
          out += `* ${index + 1} FETCH (UID ${uid} FLAGS (${flags})${modseqPart})\r\n`
        })
        write(`${out}${tag} OK done\r\n`)
        break
      }
      case 'LIST':
        write(`* LIST () "/" INBOX\r\n${tag} OK done\r\n`)
        break
      case 'LOGOUT':
        socket.end(`* BYE\r\n${tag} OK bye\r\n`)
        break
      default:
        write(`${tag} OK done\r\n`)
    }
  }

  async function seedLocation(uid: number, flags: string[]): Promise<void> {
    const message = await pool.query<{ id: string }>(
      `INSERT INTO message (id, account_id, message_id_header, subject_enc, from_enc,
         recipients_enc, snippet_enc, metadata_version)
       VALUES (gen_random_uuid(), $1, $2, '\\x00', '\\x00', '\\x00', '\\x00', 1000000) RETURNING id`,
      [accountId, `<${randomUUID()}@condstore.test>`],
    )
    await pool.query(
      `INSERT INTO message_location (message_id, folder_id, uidvalidity, uid, flags)
       VALUES ($1, $2, 7, $3, $4)`,
      [message.rows[0]!.id, folderId, uid, flags],
    )
  }

  async function locations(): Promise<Map<number, string[]>> {
    const { rows } = await pool.query<{ uid: string; flags: string[] }>(
      'SELECT uid::text AS uid, flags FROM message_location WHERE folder_id = $1',
      [folderId],
    )
    return new Map(rows.map((row) => [Number(row.uid), [...row.flags].sort()]))
  }

  async function storedModseq(): Promise<string | null> {
    const { rows } = await pool.query<{ highestmodseq: string | null }>(
      'SELECT highestmodseq::text AS highestmodseq FROM folder WHERE id = $1',
      [folderId],
    )
    return rows[0]!.highestmodseq
  }

  const flagFetches = (): string[] => commands.filter((line) => /FETCH/i.test(line))

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl })
    await runMigrations(pool)
    await pool.query(
      'TRUNCATE session, device, "user", mail_account, identity, folder, job, message CASCADE',
    )
    dataDir = await mkdtemp(path.join(tmpdir(), 'fma-condstore-'))
    process.env.MAIL_DATA_DIR = dataDir

    server = net.createServer((socket) => {
      sockets.push(socket)
      socket.write(`* OK [CAPABILITY ${mailbox.capabilities}] fake ready\r\n`)
      let buffer = ''
      socket.on('data', (chunk) => {
        buffer += chunk.toString('latin1')
        let index: number
        while ((index = buffer.indexOf('\r\n')) >= 0) {
          const line = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          handle(socket, line)
        }
      })
      socket.on('error', () => {})
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port

    const user = await pool.query<{ id: string }>(
      `INSERT INTO "user" (email, password_hash) VALUES ($1, 'x') RETURNING id`,
      [`condstore-${Date.now()}@example.com`],
    )
    accountId = randomUUID()
    const dek = generateDataKey()
    const wrappedDek = wrapDataKey(loadMasterKey(process.env.MASTER_KEY!), dek, 'v1')
    const credentialEnc = Buffer.from(
      encryptField(
        dek,
        JSON.stringify({ imapUser: 'user@condstore.test', imapPassword: 'secret' }),
        `mail_account.credential:${accountId}`,
      ),
      'utf8',
    )
    await pool.query(
      `INSERT INTO mail_account
         (id, user_id, display_name, email_address, imap_host, imap_port,
          smtp_host, smtp_port, wrapped_dek, key_id, credential_enc, status)
       VALUES ($1, $2, 'Condstore', 'user@condstore.test', '127.0.0.1', $3,
         '127.0.0.1', 3025, $4, 'v1', $5, 'ok')`,
      [accountId, user.rows[0]!.id, port, wrappedDek, credentialEnc],
    )
  })

  beforeEach(async () => {
    commands = []
    await pool.query('DELETE FROM message WHERE account_id = $1', [accountId])
    await pool.query('DELETE FROM folder WHERE account_id = $1', [accountId])
    const folder = await pool.query<{ id: string }>(
      `INSERT INTO folder (account_id, path, special_use, uidvalidity, highestmodseq)
       VALUES ($1, 'INBOX', 'inbox', 7, 10) RETURNING id`,
      [accountId],
    )
    folderId = folder.rows[0]!.id
    await seedLocation(1, [])
    await seedLocation(2, ['\\Flagged'])
    await seedLocation(3, [])
    // Server: uid 1 got \Seen (modseq 12), uid 3 was expunged.
    mailbox = {
      capabilities: 'IMAP4rev1 ENABLE CONDSTORE',
      highestModseq: 12n,
      uids: [1, 2],
      flags: new Map([
        [1, ['\\Seen']],
        [2, ['\\Flagged']],
      ]),
      modseqs: new Map([
        [1, 12n],
        [2, 5n],
      ]),
    }
  })

  afterAll(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await pool.query(
      'TRUNCATE session, device, "user", mail_account, identity, folder, job, message CASCADE',
    )
    await pool.end()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('fetches only flags changed since the stored modseq and detects expunges', async () => {
    await runMessageSync(pool, accountId, folderId)

    expect(commands.some((line) => /ENABLE .*CONDSTORE/i.test(line))).toBe(true)
    expect(commands.some((line) => /UID SEARCH ALL/i.test(line))).toBe(true)
    const fetches = flagFetches()
    expect(fetches).toHaveLength(1)
    expect(fetches[0]).toMatch(/CHANGEDSINCE 10\)/)
    expect(await locations()).toEqual(
      new Map([
        [1, ['\\Seen']],
        [2, ['\\Flagged']],
      ]),
    )
    expect(await storedModseq()).toBe('12')

    // HIGHESTMODSEQ unchanged: no flag fetch at all; expunges still found.
    commands = []
    mailbox.uids = [2]
    await runMessageSync(pool, accountId, folderId)
    expect(flagFetches()).toHaveLength(0)
    expect([...(await locations()).keys()]).toEqual([2])
    expect(await storedModseq()).toBe('12')
  })

  it('handles 63-bit modseq values without precision loss', async () => {
    const stored = 2n ** 62n + 1n
    await pool.query('UPDATE folder SET highestmodseq = $2 WHERE id = $1', [
      folderId,
      stored.toString(),
    ])
    mailbox.highestModseq = stored + 4n
    mailbox.modseqs.set(1, stored + 4n)
    mailbox.modseqs.set(2, stored - 3n)
    await runMessageSync(pool, accountId, folderId)
    const fetches = flagFetches()
    expect(fetches).toHaveLength(1)
    expect(fetches[0]).toContain(`CHANGEDSINCE ${stored})`)
    expect((await locations()).get(1)).toEqual(['\\Seen'])
    expect(await storedModseq()).toBe((stored + 4n).toString())
  })

  it('falls back to the full flag listing without a stored modseq', async () => {
    await pool.query('UPDATE folder SET highestmodseq = NULL WHERE id = $1', [folderId])
    await runMessageSync(pool, accountId, folderId)
    const fetches = flagFetches()
    expect(fetches).toHaveLength(1)
    expect(fetches[0]).not.toMatch(/CHANGEDSINCE/)
    expect(commands.some((line) => /SEARCH ALL/i.test(line))).toBe(false)
    expect((await locations()).get(1)).toEqual(['\\Seen'])
    expect(await storedModseq()).toBe('12')
  })

  it('falls back after a failed message_action write-back since the last sync', async () => {
    await pool.query(
      `INSERT INTO job (type, account_id, state, payload) VALUES ('message_action', $1, 'failed', '{}')`,
      [accountId],
    )
    try {
      await runMessageSync(pool, accountId, folderId)
      expect(flagFetches()[0]).not.toMatch(/CHANGEDSINCE/)
      // After this sync the old failure no longer forces the full listing.
      commands = []
      mailbox.highestModseq = 13n
      mailbox.modseqs.set(2, 13n)
      mailbox.flags.set(2, [])
      await runMessageSync(pool, accountId, folderId)
      expect(flagFetches()[0]).toMatch(/CHANGEDSINCE 12\)/)
      expect((await locations()).get(2)).toEqual([])
    } finally {
      await pool.query('DELETE FROM job WHERE account_id = $1', [accountId])
    }
  })

  it('uses the full listing on servers without CONDSTORE and on NOMODSEQ mailboxes', async () => {
    mailbox.capabilities = 'IMAP4rev1 ENABLE'
    await runMessageSync(pool, accountId, folderId)
    expect(flagFetches()[0]).not.toMatch(/CHANGEDSINCE|MODSEQ/)
    expect((await locations()).get(1)).toEqual(['\\Seen'])
    expect(await storedModseq()).toBeNull()

    mailbox.capabilities = 'IMAP4rev1 ENABLE CONDSTORE'
    mailbox.highestModseq = null
    await pool.query('UPDATE folder SET highestmodseq = 10 WHERE id = $1', [folderId])
    commands = []
    await runMessageSync(pool, accountId, folderId)
    expect(flagFetches()[0]).not.toMatch(/CHANGEDSINCE/)
    expect([...(await locations()).keys()].sort()).toEqual([1, 2])
    expect(await storedModseq()).toBeNull()
  })
})
