/**
 * message_action job (roadmap 2.4): writes a user action that the API has
 * already applied optimistically to the local database back to the IMAP
 * server - flags (\Seen, \Flagged), moves (move/archive/delete to Trash) and
 * permanent deletes (\Deleted + EXPUNGE inside Trash).
 *
 * - UID commands only (never sequence numbers: another client may expunge
 *   concurrently). UIDs that are gone on the server are skipped.
 * - UIDVALIDITY check: if the folder's UIDVALIDITY changed since the action,
 *   the stored UIDs are meaningless; the action is dropped and the folder
 *   resynced (the sync discards the stale locations).
 * - Failures throw and are retried with the job queue's backoff; every job
 *   belongs to one account, so a broken account never blocks others.
 *
 * Consistency trade-off (simplest acceptable approach): the worker claims
 * message_action jobs before sync jobs (see main.ts), so a write-back
 * normally reaches the server before the next message_sync of the folder.
 * If a sync still runs first (job in backoff, sync already in flight), it
 * reconciles to server truth and may briefly revert the optimistic change;
 * the write-back then re-applies flags locally, and moved messages settle
 * after the follow-up syncs enqueued here. The server stays the source of
 * truth in every case.
 */
import { ImapFlow } from 'imapflow'
import type { MailboxLockObject } from 'imapflow'
import type { Pool } from '@fma/db'
import type { MessageActionJobPayload, MessageActionOperation } from '@fma/shared'
import { loadAccountContext, type AccountContext } from '../accounts'
import { closeOnJobAbort } from '../job-context'
import { log } from '../log'
import { imapTransportOptions } from '@fma/shared/mail-transport'
import { enqueueMessageSync } from '../scheduler'
import { removeOrphanMessages } from './message-sync'

const OPERATIONS = new Set<MessageActionOperation>([
  'read',
  'unread',
  'flag',
  'unflag',
  'move',
  'expunge',
])

/** Flag changes per operation: [flag, add?]. */
const FLAG_OPERATIONS: Partial<Record<MessageActionOperation, [string, boolean]>> = {
  read: ['\\Seen', true],
  unread: ['\\Seen', false],
  flag: ['\\Flagged', true],
  unflag: ['\\Flagged', false],
}

export type MessageActionOutcome = 'done' | 'folder_missing' | 'uidvalidity_changed'

/** Validates the untyped job payload (ids only). */
export function parseMessageActionPayload(
  payload: Record<string, unknown>,
): MessageActionJobPayload {
  const { operation, folderId, uidvalidity, items, targetFolderId } = payload
  if (!OPERATIONS.has(operation as MessageActionOperation)) {
    throw new Error('message_action job with invalid operation')
  }
  if (typeof folderId !== 'string' || typeof uidvalidity !== 'string' || !Array.isArray(items)) {
    throw new Error('message_action job with invalid payload')
  }
  if (operation === 'move' && typeof targetFolderId !== 'string') {
    throw new Error('message_action move job without target folder')
  }
  const parsedItems = items.map((item) => {
    const { uid, locationId, messageId } = (item ?? {}) as Record<string, unknown>
    if (!Number.isInteger(uid) || (uid as number) <= 0) {
      throw new Error('message_action job with invalid uid')
    }
    return { uid: uid as number, locationId: String(locationId), messageId: String(messageId) }
  })
  return {
    operation: operation as MessageActionOperation,
    folderId,
    uidvalidity,
    items: parsedItems,
    ...(typeof targetFolderId === 'string' ? { targetFolderId } : {}),
  }
}

async function folderPath(pool: Pool, accountId: string, folderId: string): Promise<string | null> {
  const { rows } = await pool.query<{ path: string }>(
    'SELECT path FROM folder WHERE id = $1 AND account_id = $2',
    [folderId, accountId],
  )
  return rows[0]?.path ?? null
}

async function applyFlagsLocally(
  pool: Pool,
  locationIds: string[],
  flag: string,
  add: boolean,
): Promise<void> {
  await pool.query(
    add
      ? `UPDATE message_location SET flags = array_append(flags, $2)
         WHERE id = ANY($1::uuid[]) AND NOT ($2 = ANY(flags))`
      : `UPDATE message_location SET flags = array_remove(flags, $2)
         WHERE id = ANY($1::uuid[])`,
    [locationIds, flag],
  )
}

/**
 * Turns move placeholders into real locations using the server's COPYUID
 * mapping (UIDPLUS). Without a mapping the next sync of the target folder
 * replaces the placeholders instead.
 */
async function resolvePlaceholders(
  pool: Pool,
  targetFolderId: string,
  items: MessageActionJobPayload['items'],
  uidMap: Map<number, number> | undefined,
  uidValidity: bigint | undefined,
): Promise<void> {
  if (!uidMap || uidValidity === undefined) return
  for (const item of items) {
    const newUid = uidMap.get(item.uid)
    if (newUid === undefined) continue
    const { rowCount } = await pool.query(
      `UPDATE message_location SET uidvalidity = $2, uid = $3
       WHERE id = $1 AND uid < 0
         AND NOT EXISTS (
           SELECT 1 FROM message_location
           WHERE folder_id = $4 AND uidvalidity = $2 AND uid = $3
         )`,
      [item.locationId, uidValidity.toString(), newUid, targetFolderId],
    )
    if (rowCount === 0) {
      // A sync already stored the real location: drop the placeholder.
      await pool.query('DELETE FROM message_location WHERE id = $1 AND uid < 0', [item.locationId])
    }
  }
}

export async function runMessageAction(
  pool: Pool,
  accountId: string,
  rawPayload: Record<string, unknown>,
  context?: AccountContext,
): Promise<MessageActionOutcome> {
  const payload = parseMessageActionPayload(rawPayload)
  const { operation, folderId, items } = payload

  const sourcePath = await folderPath(pool, accountId, folderId)
  const targetPath =
    operation === 'move' ? await folderPath(pool, accountId, payload.targetFolderId!) : null
  if (!sourcePath || (operation === 'move' && !targetPath)) {
    // Folder vanished on the server meanwhile: nothing to write back; the
    // next syncs drop the placeholders and restore what is still there.
    log.warn({ accountId, folderId, operation }, 'message_action folder missing, dropped')
    return 'folder_missing'
  }

  const ctx = context ?? (await loadAccountContext(pool, accountId, process.env.MASTER_KEY ?? ''))
  const transport = await imapTransportOptions(ctx.imap)
  const client = new ImapFlow({
    ...transport,
    auth: { user: ctx.imap.user, pass: ctx.imap.password },
    logger: false,
    greetingTimeout: 15_000,
  })

  const unregister = closeOnJobAbort(() => client.close())
  let lock: MailboxLockObject | null = null
  let outcome: MessageActionOutcome = 'done'
  try {
    await client.connect()
    lock = await client.getMailboxLock(sourcePath)
    const selected = (
      client as unknown as { mailbox?: { uidValidity?: bigint | string; exists?: number } }
    ).mailbox
    if (!selected) throw new Error('mailbox could not be selected')

    if (BigInt(selected.uidValidity ?? 0) !== BigInt(payload.uidvalidity)) {
      outcome = 'uidvalidity_changed'
    } else {
      // Skip UIDs that are already gone (expunged/moved by another client).
      const present = new Set<number>()
      if ((selected.exists ?? 0) > 0) {
        for await (const msg of client.fetch('1:*', { uid: true })) present.add(msg.uid)
      }
      const uids = items.map((item) => item.uid).filter((uid) => present.has(uid))

      const flagChange = FLAG_OPERATIONS[operation]
      if (flagChange) {
        const [flag, add] = flagChange
        if (uids.length > 0) {
          if (add) await client.messageFlagsAdd(uids, [flag], { uid: true })
          else await client.messageFlagsRemove(uids, [flag], { uid: true })
        }
        // Re-apply locally: a sync that ran in between may have reverted
        // the optimistic change to the (then) server state.
        await applyFlagsLocally(
          pool,
          items.map((item) => item.locationId),
          flag,
          add,
        )
      } else if (operation === 'move') {
        if (uids.length > 0) {
          const result = await client.messageMove(uids, targetPath!, { uid: true })
          if (result) {
            await resolvePlaceholders(
              pool,
              payload.targetFolderId!,
              items,
              result.uidMap,
              result.uidValidity,
            )
          }
        }
      } else if (operation === 'expunge') {
        if (uids.length > 0) await client.messageDelete(uids, { uid: true })
        await removeOrphanMessages(
          pool,
          accountId,
          items.map((item) => item.messageId),
        )
      }
    }
  } finally {
    lock?.release()
    unregister()
    await client.logout().catch(() => client.close())
  }

  if (outcome === 'uidvalidity_changed') {
    log.warn({ accountId, folderId, operation }, 'message_action uidvalidity changed, dropped')
  }
  // Moves: the source sync confirms the removal, the target sync learns the
  // new UIDs if the server sent no COPYUID. After a dropped action, both
  // syncs restore the server state.
  if (operation === 'move' || outcome === 'uidvalidity_changed') {
    await enqueueMessageSync(pool, accountId, folderId)
    if (payload.targetFolderId) {
      await enqueueMessageSync(pool, accountId, payload.targetFolderId)
    }
  }
  return outcome
}
