/**
 * Static PWA served by the api (ADR-0007, no web container). Needs no
 * database: only the not-found handler and the security headers run.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app'

const APP_CSP = "default-src 'self'; script-src 'self'"
let webDir: string
let app: FastifyInstance

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), 'fma-web-'))
  const pub = join(webDir, 'public')
  mkdirSync(join(pub, '_nuxt'), { recursive: true })
  mkdirSync(join(pub, 'icons'))
  writeFileSync(join(pub, 'index.html'), '<!doctype html><title>app</title>')
  writeFileSync(join(pub, 'sw.js'), 'self.addEventListener("fetch", () => {})')
  writeFileSync(join(pub, 'manifest.webmanifest'), '{}')
  writeFileSync(join(pub, '_nuxt', 'entry.abc123.js'), 'console.log(1)')
  writeFileSync(join(pub, 'icons', 'icon-192.png'), 'png')
  writeFileSync(join(webDir, 'secret.txt'), 'outside public')
  writeFileSync(
    join(webDir, 'security-headers.json'),
    JSON.stringify({ 'Content-Security-Policy': APP_CSP, 'X-Frame-Options': 'DENY' }),
  )
  app = buildApp({ logger: false, webDir })
  await app.ready()
})

afterAll(async () => {
  await app.close()
  rmSync(webDir, { recursive: true, force: true })
})

describe('static PWA', () => {
  it('serves index.html with the app CSP and no-cache', async () => {
    const res = await app.inject({ method: 'GET', url: '/' })

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(res.headers['content-security-policy']).toBe(APP_CSP)
    expect(res.headers['cache-control']).toBe('no-cache')
    expect(res.body).toContain('<title>app</title>')
  })

  it('falls back to the app shell for client routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/accounts/42/inbox?x=1' })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('<title>app</title>')
    expect(res.headers['cache-control']).toBe('no-cache')
  })

  it('caches hashed assets forever and icons for a day', async () => {
    const asset = await app.inject({ method: 'GET', url: '/_nuxt/entry.abc123.js' })
    expect(asset.statusCode).toBe(200)
    expect(asset.headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable')

    const icon = await app.inject({ method: 'GET', url: '/icons/icon-192.png' })
    expect(icon.headers['content-type']).toBe('image/png')
    expect(icon.headers['cache-control']).toBe('public, max-age=86400')
  })

  it('revalidates sw.js and the manifest', async () => {
    const sw = await app.inject({ method: 'GET', url: '/sw.js' })
    expect(sw.headers['cache-control']).toBe('no-cache')

    const manifest = await app.inject({ method: 'GET', url: '/manifest.webmanifest' })
    expect(manifest.headers['content-type']).toBe('application/manifest+json; charset=utf-8')
    expect(manifest.headers['cache-control']).toBe('no-cache')
  })

  it('answers 304 for a matching ETag', async () => {
    const first = await app.inject({ method: 'GET', url: '/sw.js' })
    const etag = first.headers.etag as string

    const res = await app.inject({
      method: 'GET',
      url: '/sw.js',
      headers: { 'if-none-match': etag },
    })

    expect(res.statusCode).toBe(304)
    expect(res.body).toBe('')
  })

  it('returns 404 for missing hashed assets instead of the app shell', async () => {
    const res = await app.inject({ method: 'GET', url: '/_nuxt/gone.js' })
    expect(res.statusCode).toBe(404)
  })

  it('never serves files outside the public directory', async () => {
    for (const url of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt']) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.body).not.toContain('outside public')
    }
  })

  it('keeps unknown api paths and other methods as plain 404', async () => {
    const api = await app.inject({ method: 'GET', url: '/api/does-not-exist' })
    expect(api.statusCode).toBe(404)
    expect(api.json()).toMatchObject({ statusCode: 404, error: 'Not Found' })
    expect(api.headers['content-security-policy']).toContain("default-src 'none'")

    const post = await app.inject({ method: 'POST', url: '/somewhere' })
    expect(post.statusCode).toBe(404)
  })

  it('refuses to start without a built app', () => {
    expect(() => buildApp({ logger: false, webDir: join(webDir, 'missing') })).toThrow(/WEB_DIR/)
  })
})
