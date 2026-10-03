/**
 * Per-job abort signal (roadmap 3.4): the job runner aborts a job that
 * exceeds its hard timeout. Jobs register their provider connections here,
 * so the abort closes them and a hanging provider cannot keep a connection
 * (or the job) alive. AsyncLocalStorage keeps the job signatures unchanged.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

const storage = new AsyncLocalStorage<{ signal: AbortSignal }>()

export function runWithJobSignal<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  return storage.run({ signal }, fn)
}

/**
 * Calls `close` when the current job is aborted (immediately if it already
 * was). Returns a function that unregisters it; outside a job it is a no-op.
 */
export function closeOnJobAbort(close: () => void): () => void {
  const signal = storage.getStore()?.signal
  if (!signal) return () => {}
  if (signal.aborted) {
    close()
    return () => {}
  }
  const onAbort = (): void => close()
  signal.addEventListener('abort', onAbort, { once: true })
  return () => signal.removeEventListener('abort', onAbort)
}

/** True when the current job was aborted (long loops stop between batches). */
export function jobAborted(): boolean {
  return storage.getStore()?.signal.aborted ?? false
}
