/**
 * Request scope for views that switch context (roadmap 3.2, account
 * switch): every read runs in the current scope; `reset()` starts a new one,
 * aborts the requests of the previous scope and makes responses that still
 * arrive late fail with StaleResponseError instead of landing in the new
 * view. Pure logic, no framework dependency.
 */

export class StaleResponseError extends Error {
  constructor() {
    super('response belongs to a previous scope')
    this.name = 'StaleResponseError'
  }
}

/** True for errors of requests that belong to a previous scope. */
export function isStaleResponse(err: unknown): boolean {
  return (
    err instanceof StaleResponseError ||
    (typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError')
  )
}

export class RequestScope {
  private epoch = 0
  private controller = new AbortController()

  /** Opaque token of the current scope (compare with `isCurrent`). */
  get token(): number {
    return this.epoch
  }

  isCurrent(token: number): boolean {
    return token === this.epoch
  }

  /** Starts a new scope: aborts and invalidates everything of the previous one. */
  reset(): void {
    this.epoch++
    this.controller.abort()
    this.controller = new AbortController()
  }

  /**
   * Runs a request in the current scope. Resolves only if the scope is still
   * current when the request settles; otherwise rejects with
   * StaleResponseError (also for errors of a stale request).
   */
  async run<T>(request: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const token = this.epoch
    try {
      const result = await request(this.controller.signal)
      if (token !== this.epoch) throw new StaleResponseError()
      return result
    } catch (err) {
      if (token !== this.epoch) throw new StaleResponseError()
      throw err
    }
  }
}
