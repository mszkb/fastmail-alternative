import { describe, expect, it } from 'vitest'
import { RequestScope, StaleResponseError, isStaleResponse } from '../src/request-scope'

/** A request that settles when the test says so. */
function deferred<T>(): {
  request: (signal: AbortSignal) => Promise<T>
  resolve: (value: T) => void
  reject: (err: unknown) => void
  signal: () => AbortSignal | undefined
} {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  let seen: AbortSignal | undefined
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return {
    request: (signal) => {
      seen = signal
      return promise
    },
    resolve,
    reject,
    signal: () => seen,
  }
}

describe('RequestScope', () => {
  it('passes responses of the current scope through', async () => {
    const scope = new RequestScope()
    await expect(scope.run(async () => 'account A')).resolves.toBe('account A')
  })

  it('drops a late response of the previous scope (account switch)', async () => {
    const scope = new RequestScope()
    const slowA = deferred<string>()
    const pendingA = scope.run(slowA.request)

    scope.reset() // switch to account B
    const responseB = await scope.run(async () => 'account B')
    slowA.resolve('account A') // A's response arrives after B's

    expect(responseB).toBe('account B')
    await expect(pendingA).rejects.toBeInstanceOf(StaleResponseError)
  })

  it('aborts in-flight requests on reset and reports them as stale', async () => {
    const scope = new RequestScope()
    const slow = deferred<string>()
    const pending = scope.run(slow.request)
    expect(slow.signal()?.aborted).toBe(false)

    scope.reset()
    expect(slow.signal()?.aborted).toBe(true)
    const abortError = new Error('aborted')
    abortError.name = 'AbortError'
    slow.reject(abortError)
    const err = await pending.catch((e: unknown) => e)
    expect(isStaleResponse(err)).toBe(true)
  })

  it('keeps real errors of the current scope', async () => {
    const scope = new RequestScope()
    const err = await scope
      .run(async () => {
        throw new Error('Fehler 500')
      })
      .catch((e: unknown) => e)
    expect(isStaleResponse(err)).toBe(false)
    expect((err as Error).message).toBe('Fehler 500')
  })

  it('tokens identify the scope', () => {
    const scope = new RequestScope()
    const token = scope.token
    expect(scope.isCurrent(token)).toBe(true)
    scope.reset()
    expect(scope.isCurrent(token)).toBe(false)
  })
})
