/**
 * Drafts (roadmap 2.8): request/response shapes of the draft API and the
 * pure rules the clients share (offline overlay).
 *
 * A draft lives on the server (encrypted with the account DEK), so it
 * survives a reload and a device change; the worker mirrors it into the
 * account's IMAP Drafts folder for other mail clients. Recipients are kept
 * exactly as typed (field text), because a draft may be incomplete.
 */
import type { QueuedOperation } from './offline'

/** Limits of `PUT /api/drafts/:id`. */
export const DRAFT_LIMITS = {
  /** Raw text of one address field (to, cc or bcc). */
  maxAddressFieldLength: 20_000,
  maxSubjectLength: 998,
  /** Plain text body, in characters (same as sending). */
  maxTextLength: 500_000,
  maxReferences: 100,
} as const

/** Encrypted content of a draft (JSON in `draft.content_enc`). */
export interface DraftContent {
  /** Address fields as typed, e.g. "Anna <anna@example.com>, bob@example.org". */
  to: string
  cc: string
  bcc: string
  subject: string
  text: string
}

/**
 * `PUT /api/drafts/:id` - creates (201) or updates (200) a draft; the id is
 * a client-generated UUID. `baseVersion` is the version the client edited
 * (0 or missing for a new draft - only such a save creates it): when the
 * draft was saved elsewhere meanwhile, the server answers 409 with the
 * current draft (`DraftConflictResponse`) unless `force` is set (last write
 * wins). A deleted or sent draft answers 410.
 */
export interface SaveDraftRequest extends DraftContent {
  accountId: string
  identityId?: string | null
  inReplyTo?: string | null
  references?: string[]
  baseVersion?: number
  force?: boolean
}

/** A draft as the API returns it (decrypted). */
export interface Draft extends DraftContent {
  id: string
  accountId: string
  identityId: string | null
  inReplyTo: string | null
  references: string[]
  version: number
  createdAt: string
  updatedAt: string
  /**
   * Local message ids of the draft's copy in the IMAP Drafts folder (once
   * uploaded and synced), so a list can show the draft only once.
   */
  messageIds: string[]
}

/** `GET /api/accounts/:id/drafts` - newest first. */
export interface DraftListResponse {
  drafts: Draft[]
}

/** 409 answer of `PUT /api/drafts/:id`: the version saved on another device. */
export interface DraftConflictResponse {
  message: string
  draft: Draft
}

/** Payload of the `draft_sync` job (ids only). */
export interface DraftSyncJobPayload {
  draftId: string
}

/**
 * Applies queued (not yet replayed) draft saves and deletes of an account
 * to a draft list loaded from the cache or the server, so drafts written
 * offline show up - also after a reload. Newest first.
 */
export function overlayPendingDrafts(
  drafts: readonly Draft[],
  accountId: string,
  queue: readonly QueuedOperation[],
): Draft[] {
  const byId = new Map(drafts.map((draft) => [draft.id, draft]))
  for (const entry of queue) {
    if (entry.kind !== 'draft' || entry.accountId !== accountId) continue
    const { draftId, body } = entry.request
    if (!body) {
      byId.delete(draftId)
      continue
    }
    const existing = byId.get(draftId)
    byId.set(draftId, {
      id: draftId,
      accountId,
      identityId: body.identityId ?? null,
      inReplyTo: body.inReplyTo ?? null,
      references: body.references ?? [],
      to: body.to,
      cc: body.cc,
      bcc: body.bcc,
      subject: body.subject,
      text: body.text,
      version: existing?.version ?? 0,
      createdAt: existing?.createdAt ?? entry.createdAt,
      updatedAt: entry.createdAt,
      messageIds: existing?.messageIds ?? [],
    })
  }
  return [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}
