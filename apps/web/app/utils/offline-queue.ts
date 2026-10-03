// Offline queue (roadmap 4.6): message actions and sends that could not
// reach the server are kept (encrypted, see offline-store.ts) and replayed
// in order once the app is online again (start, `online`, focus). The
// rules - coalescing, what to do with each answer - are in @fma/shared
// (offline.ts). Sends carry a clientId, so a replay never sends twice.
// Multiple tabs: queue changes and replays run under a Web Lock.
import {
  pendingLabel,
  queueOperation,
  replayDecision,
  type MessageActionRequest,
  type QueuedOperation,
  type SendMessageRequest,
} from '@fma/shared'
import { computed, reactive } from 'vue'
import { cacheDelete, cacheGet, cachePut, offlineStoreSupported } from './offline-store'

const QUEUE_KEY = 'queue'
const LOCK_NAME = 'fma-offline-queue'

/** Reactive offline state for the indicator and the views. */
export const offlineState = reactive({
  /** Browser reports a connection (navigator.onLine). */
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  /** Last API request reached the server (false: offline mode with cached data). */
  reachable: true,
  /** Queued operations, in order (mirrors the stored queue). */
  queue: [] as QueuedOperation[],
  replaying: false,
  /** Non-blocking notices (dropped actions, queued sends). */
  notices: [] as string[],
  /** Bumped after a replay changed server data: views reload. */
  replayedAt: 0,
})

export const pendingCount = computed(() => offlineState.queue.length)
export const pendingText = computed(() => pendingLabel(offlineState.queue.length))
export const isOffline = computed(() => !offlineState.online || !offlineState.reachable)

let unauthorizedHandler: (() => void) | null = null

/** app.vue: what to do when the server says the session is gone (401). */
export function onUnauthorized(handler: () => void): void {
  unauthorizedHandler = handler
}

export function notifyUnauthorized(): void {
  unauthorizedHandler?.()
}

export function addNotice(text: string): void {
  offlineState.notices = [...offlineState.notices, text]
}

export function dismissNotice(index: number): void {
  offlineState.notices = offlineState.notices.filter((_, i) => i !== index)
}

/** fetch() failed without an answer from the server (offline, DNS, reset). */
export function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError
}

/** UUID v4; also without a secure context (crypto.randomUUID needs one). */
export function newId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Serializes queue access in this tab and (with Web Locks) across tabs. */
let chain: Promise<unknown> = Promise.resolve()
function withQueueLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = 'locks' in navigator ? navigator.locks : undefined
  const run = (): Promise<T> => (locks ? (locks.request(LOCK_NAME, fn) as Promise<T>) : fn())
  const next: Promise<T> = chain.then(run, run)
  chain = next.catch(() => {})
  return next
}

async function readQueue(): Promise<QueuedOperation[]> {
  // Without IndexedDB/WebCrypto the queue lives in memory only (this tab).
  if (!offlineStoreSupported()) return offlineState.queue
  return (await cacheGet<QueuedOperation[]>(QUEUE_KEY)) ?? []
}

async function writeQueue(queue: QueuedOperation[]): Promise<void> {
  offlineState.queue = queue
  if (queue.length === 0) await cacheDelete(QUEUE_KEY)
  else await cachePut(QUEUE_KEY, queue, { pinned: true })
}

/** Loads the stored queue into offlineState (app start, other tab changed it). */
export async function loadQueue(): Promise<void> {
  offlineState.queue = await withQueueLock(readQueue)
}

async function enqueue(operation: QueuedOperation): Promise<void> {
  await withQueueLock(async () => {
    await writeQueue(queueOperation(await readQueue(), operation))
  })
}

export function enqueueAction(accountId: string, request: MessageActionRequest): Promise<void> {
  return enqueue({
    kind: 'action',
    id: newId(),
    accountId,
    createdAt: new Date().toISOString(),
    attempts: 0,
    request,
  })
}

export function enqueueSend(request: SendMessageRequest & { clientId: string }): Promise<void> {
  return enqueue({
    kind: 'send',
    id: request.clientId,
    accountId: request.accountId,
    createdAt: new Date().toISOString(),
    attempts: 0,
    request,
  })
}

/** Forgets the in-memory queue (the stored one is gone with clearOfflineData). */
export function resetOfflineState(): void {
  offlineState.queue = []
  offlineState.notices = []
  offlineState.reachable = true
}

async function sendOperation(operation: QueuedOperation): Promise<Response> {
  const path = operation.kind === 'send' ? '/api/outbox' : '/api/messages/actions'
  return fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(operation.request),
  })
}

function dropNotice(operation: QueuedOperation, serverMessage: string | undefined): string {
  const reason = serverMessage ? ` (${serverMessage})` : ''
  return operation.kind === 'send'
    ? `Eine offline geschriebene Nachricht konnte nicht gesendet werden${reason}.`
    : `Eine offline ausgeführte Aktion wurde verworfen${reason}.`
}

/**
 * Replays the queue in order. Stops at the first operation that should be
 * retried later (keeps the order) or when the session is gone.
 */
export async function replayQueue(): Promise<void> {
  if (offlineState.replaying || !navigator.onLine) return
  offlineState.replaying = true
  let changed = false
  let unauthorized = false
  try {
    await withQueueLock(async () => {
      let queue = await readQueue()
      while (queue.length > 0) {
        const operation = queue[0]!
        let status: number | 'network'
        let serverMessage: string | undefined
        try {
          const res = await sendOperation(operation)
          status = res.status
          offlineState.reachable = true
          if (!res.ok) {
            const body = (await res.json().catch(() => null)) as { message?: string } | null
            serverMessage = body?.message
          }
        } catch {
          status = 'network'
          offlineState.reachable = false
        }
        const decision = replayDecision(status, operation.attempts)
        if (decision === 'retry') {
          if (status !== 'network') {
            queue = [{ ...operation, attempts: operation.attempts + 1 }, ...queue.slice(1)]
            await writeQueue(queue)
          }
          break
        }
        if (decision === 'unauthorized') {
          unauthorized = true
          break
        }
        if (decision === 'drop') addNotice(dropNotice(operation, serverMessage))
        changed = true
        queue = queue.slice(1)
        await writeQueue(queue)
      }
      offlineState.queue = queue
    })
  } finally {
    offlineState.replaying = false
  }
  if (changed) offlineState.replayedAt = Date.now()
  if (unauthorized) notifyUnauthorized()
}
