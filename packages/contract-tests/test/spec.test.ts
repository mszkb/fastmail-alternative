// Static checks of docs/api/openapi.yaml; runs without a backend.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { spec } from '../src/openapi'

const METHODS = ['get', 'put', 'post', 'delete', 'patch']

describe('OpenAPI spec', () => {
  const operations = Object.entries(spec.paths).flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([method]) => METHODS.includes(method))
      .map(([method, op]) => ({ path, method, op: op as Record<string, unknown> })),
  )

  it('has a unique operationId, a success response and 401 on authenticated routes', () => {
    const ids = operations.map((o) => o.op.operationId)
    expect(ids.every((id) => typeof id === 'string')).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
    for (const { path, method, op } of operations) {
      const codes = Object.keys((op.responses ?? {}) as object)
      expect(
        // 303: redirect-only routes (OAuth callback back to the PWA).
        codes.some((c) => c.startsWith('2') || c === '303'),
        `${method} ${path} success`,
      ).toBe(true)
      const isPublic = Array.isArray(op.security) && op.security.length === 0
      const usesSession = !Array.isArray(op.security)
      if (!isPublic && usesSession) expect(codes, `${method} ${path} 401`).toContain('401')
    }
  })

  it('is up to date with docs/api/parts', () => {
    const script = fileURLToPath(new URL('../scripts/build-openapi.mjs', import.meta.url))
    const result = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })

  it('resolves every $ref', () => {
    const missing: string[] = []
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) return value.forEach(walk)
      if (!value || typeof value !== 'object') return
      for (const [key, child] of Object.entries(value)) {
        if (key === '$ref' && typeof child === 'string') {
          let target: unknown = spec
          for (const part of child.replace(/^#\//, '').split('/')) {
            target = (target as Record<string, unknown> | undefined)?.[part]
          }
          if (target === undefined) missing.push(child)
        } else walk(child)
      }
    }
    walk(spec)
    expect(missing).toEqual([])
  })
})
