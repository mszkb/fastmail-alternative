/**
 * Threading (roadmap 2.5): a simplified JWZ algorithm as a pure function.
 *
 * Rules (per account; the caller only passes messages of one account):
 * 1. Reference links: a message joins the thread of every Message-ID it
 *    names in In-Reply-To/References. Referenced ids that are not (yet)
 *    present act as shared "phantom" parents, so siblings of a missing
 *    parent still end up together and a parent arriving later merges them.
 * 2. Subject fallback, only for messages WITHOUT any reference header whose
 *    subject carries a reply prefix (Re:, AW:, ...): the message joins the
 *    closest message with the same normalized subject within
 *    SUBJECT_THREAD_WINDOW_MS (earlier messages preferred). Unrelated mails
 *    that merely share a subject ("Rechnung", "Hallo") stay separate.
 *
 * The result does not depend on the input order. The worker runs the same
 * function on a new message plus its candidate neighbours from the
 * database (see apps/worker/src/threading.ts); subjects there are keyed
 * HMACs, never plaintext.
 */
import { baseSubject } from './compose'

/** Time window of the subject fallback (either direction). */
export const SUBJECT_THREAD_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

export interface ThreadingMessage {
  id: string
  /** Message-ID header (angle brackets); null when unknown. */
  messageId: string | null
  inReplyTo: string | null
  references: string[]
  /**
   * Normalized subject (threadSubjectKey) or a keyed hash of it; null
   * disables the subject fallback for this message.
   */
  subjectKey: string | null
  /** Subject carries a reply prefix (hasReplyPrefix of the raw subject). */
  isReply: boolean
  /** Date in epoch milliseconds; null disables the subject fallback. */
  date: number | null
}

/** Normalized subject for the fallback; null for empty subjects. */
export function threadSubjectKey(subject: string): string | null {
  const base = baseSubject(subject).toLowerCase()
  return base === '' ? null : base
}

/** Referenced Message-IDs (In-Reply-To + References), deduplicated, without the own id. */
export function threadLinks(
  message: Pick<ThreadingMessage, 'messageId' | 'inReplyTo' | 'references'>,
): string[] {
  const links = new Set<string>()
  for (const id of [...message.references, message.inReplyTo ?? '']) {
    const trimmed = id.trim()
    if (trimmed && trimmed !== message.messageId) links.add(trimmed)
  }
  return [...links]
}

/** Whether the subject fallback applies to a message (rule 2). */
export function usesSubjectFallback(message: ThreadingMessage): boolean {
  return (
    message.isReply &&
    message.subjectKey !== null &&
    message.date !== null &&
    threadLinks(message).length === 0
  )
}

/**
 * Groups messages into threads. Returns the threads as lists of message
 * ids (each in input order, threads ordered by their first message).
 */
export function groupThreads(
  messages: ThreadingMessage[],
  windowMs: number = SUBJECT_THREAD_WINDOW_MS,
): string[][] {
  const parent = new Map<string, string>()
  const find = (key: string): string => {
    let root = key
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!
    // Path compression.
    let node = key
    while (node !== root) {
      const next = parent.get(node)!
      parent.set(node, root)
      node = next
    }
    if (!parent.has(root)) parent.set(root, root)
    return root
  }
  const union = (a: string, b: string): void => {
    const rootA = find(a)
    const rootB = find(b)
    if (rootA !== rootB) parent.set(rootB, rootA)
  }
  const node = (message: ThreadingMessage): string => `m:${message.id}`

  // Rule 1: messages and the Message-IDs they carry or reference.
  for (const message of messages) {
    find(node(message))
    if (message.messageId) union(node(message), `id:${message.messageId}`)
    for (const link of threadLinks(message)) union(node(message), `id:${link}`)
  }

  // Rule 2: subject fallback to the closest message with the same subject
  // (earlier ones first; ties broken by id for order independence).
  for (const message of messages) {
    if (!usesSubjectFallback(message)) continue
    const date = message.date!
    let best: { candidate: ThreadingMessage; earlier: boolean; distance: number } | null = null
    for (const candidate of messages) {
      if (candidate.id === message.id || candidate.subjectKey !== message.subjectKey) continue
      if (candidate.date === null) continue
      const distance = Math.abs(candidate.date - date)
      if (distance > windowMs) continue
      const earlier = candidate.date <= date
      const better =
        !best ||
        (earlier && !best.earlier) ||
        (earlier === best.earlier &&
          (distance < best.distance ||
            (distance === best.distance && candidate.id < best.candidate.id)))
      if (better) best = { candidate, earlier, distance }
    }
    if (best) union(node(message), node(best.candidate))
  }

  const groups = new Map<string, string[]>()
  for (const message of messages) {
    const root = find(node(message))
    const group = groups.get(root) ?? []
    if (!group.includes(message.id)) group.push(message.id)
    groups.set(root, group)
  }
  return [...groups.values()]
}
