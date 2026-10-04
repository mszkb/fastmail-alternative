/**
 * Serves the static PWA (apps/web, built with `nuxt generate`) from the api
 * process, so the deployment needs no separate web server (ADR-0007).
 *
 * Layout of WEB_DIR (see apps/api/Dockerfile):
 *   public/                 output of `nuxt generate` incl. sw.js
 *   security-headers.json   CSP and friends, from apps/web/scripts/build-csp.mjs
 *
 * Runs as the not-found handler: every api route keeps precedence, and
 * unknown /api/* paths still get a plain 404 instead of the app shell.
 */
import { createReadStream, readFileSync, statSync, type Stats } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
}

/** Hashed assets never change; HTML, sw.js and the manifest must be revalidated. */
export function cacheControlFor(urlPath: string): string {
  if (urlPath.startsWith('/_nuxt/')) return 'public, max-age=31536000, immutable'
  if (urlPath.startsWith('/icons/')) return 'public, max-age=86400'
  return 'no-cache'
}

function fileStats(path: string): Stats | undefined {
  try {
    return statSync(path)
  } catch {
    return undefined
  }
}

function notFound(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  // Same body as Fastify's default 404.
  return reply.code(404).send({
    message: `Route ${request.method}:${request.url} not found`,
    error: 'Not Found',
    statusCode: 404,
  })
}

export function registerWebApp(app: FastifyInstance, webDir: string): void {
  const publicDir = resolve(webDir, 'public')
  const indexPath = join(publicDir, 'index.html')
  if (!fileStats(indexPath)?.isFile()) {
    throw new Error(`WEB_DIR: ${indexPath} not found`)
  }
  const securityHeaders = JSON.parse(
    readFileSync(join(webDir, 'security-headers.json'), 'utf8'),
  ) as Record<string, string>

  /** Maps a request path to a file below publicDir, or undefined. */
  function lookup(urlPath: string): { path: string; stats: Stats } | undefined {
    let decoded: string
    try {
      decoded = decodeURIComponent(urlPath)
    } catch {
      return undefined
    }
    if (decoded.includes('\0')) return undefined
    let path = resolve(publicDir, '.' + decoded)
    if (path !== publicDir && !path.startsWith(publicDir + sep)) return undefined
    let stats = fileStats(path)
    if (stats?.isDirectory()) {
      path = join(path, 'index.html')
      stats = fileStats(path)
    }
    return stats?.isFile() ? { path, stats } : undefined
  }

  app.setNotFoundHandler((request, reply) => {
    const urlPath = request.url.split('?')[0] ?? '/'
    if ((request.method !== 'GET' && request.method !== 'HEAD') || urlPath.startsWith('/api/')) {
      return notFound(request, reply)
    }

    let file = lookup(urlPath)
    if (!file) {
      // Missing hashed assets are real 404s; everything else is a client
      // route of the SPA and gets the app shell.
      if (urlPath.startsWith('/_nuxt/')) return notFound(request, reply)
      file = { path: indexPath, stats: statSync(indexPath) }
    }

    const etag = `W/"${file.stats.size.toString(16)}-${Math.floor(file.stats.mtimeMs).toString(16)}"`
    void reply.headers(securityHeaders)
    void reply.header('cache-control', cacheControlFor(file.path === indexPath ? '/' : urlPath))
    void reply.header('etag', etag)
    if (request.headers['if-none-match'] === etag) return reply.code(304).send()

    void reply.type(CONTENT_TYPES[extname(file.path)] ?? 'application/octet-stream')
    void reply.header('content-length', file.stats.size)
    if (request.method === 'HEAD') return reply.send()
    return reply.send(createReadStream(file.path))
  })
}
