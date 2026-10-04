// Writes the security headers of the PWA (roadmap 6.4) next to the
// generated static output (.output/security-headers.json); the api image
// ships it and sends the headers with every app file (apps/api/src/web-app.ts).
//
// The generated HTML contains two small inline scripts (Nuxt's import map
// and runtime config). Instead of 'unsafe-inline', the CSP allows exactly
// these scripts by their SHA-256 hash, computed here after `nuxt generate`.
//
// style-src needs 'unsafe-inline': the HTML mail view renders sanitized mail
// HTML (with <style> and style attributes) in a srcdoc iframe, and srcdoc
// documents inherit the CSP of the app. img-src allows http(s) for the same
// reason (remote images are opt-in per message). Scripts stay blocked in the
// iframe by its sandbox and its own CSP.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUTPUT_DIR = join(ROOT, '.output')
const PUBLIC_DIR = join(OUTPUT_DIR, 'public')

const htmlFiles = readdirSync(PUBLIC_DIR).filter((name) => name.endsWith('.html'))
if (!htmlFiles.includes('index.html')) {
  throw new Error(`index.html missing in ${PUBLIC_DIR} - run nuxt generate first`)
}

// Inline <script> elements that browsers execute or parse under script-src
// (classic, module and importmap scripts; JSON data blocks are inert).
const SCRIPT_RE = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi
const hashes = new Set()
for (const name of htmlFiles) {
  const html = readFileSync(join(PUBLIC_DIR, name), 'utf8')
  for (const match of html.matchAll(SCRIPT_RE)) {
    const attrs = match[1] ?? ''
    const body = match[2] ?? ''
    if (/\bsrc\s*=/i.test(attrs) || body === '') continue
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase()
    if (type && !['module', 'importmap', 'text/javascript'].includes(type)) continue
    hashes.add(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`)
  }
}

const csp = [
  "default-src 'self'",
  `script-src 'self' ${[...hashes].sort().join(' ')}`.trim(),
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

const headers = {
  'Content-Security-Policy': csp,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
}

writeFileSync(join(OUTPUT_DIR, 'security-headers.json'), JSON.stringify(headers, null, 2) + '\n')
console.log(`security-headers.json written (${hashes.size} inline script hashes)`)
