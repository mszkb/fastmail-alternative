// Writes the service worker (roadmap 4.1) into the generated static output:
// service-worker/sw.js plus the precache list (app shell: index.html, hashed
// assets, manifest, icons) and a content hash as cache version. Runs after
// `nuxt generate` (see package.json); a changed build yields a changed
// sw.js, which triggers the update prompt in the app.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC_DIR = join(ROOT, '.output', 'public')
// Not part of the shell: the worker itself and the SPA fallback copies.
const EXCLUDE = new Set(['/sw.js', '/200.html', '/404.html'])

function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? listFiles(path) : [path]
  })
}

const files = listFiles(PUBLIC_DIR)
  .map((path) => ({ path, url: '/' + relative(PUBLIC_DIR, path).split(sep).join('/') }))
  .filter((file) => !EXCLUDE.has(file.url) && !file.url.startsWith('/_nuxt/builds/'))
  .sort((a, b) => a.url.localeCompare(b.url))

if (!files.some((file) => file.url === '/index.html')) {
  throw new Error(`index.html missing in ${PUBLIC_DIR} - run nuxt generate first`)
}

const source = readFileSync(join(ROOT, 'service-worker', 'sw.js'), 'utf8')
const hash = createHash('sha256').update(source)
for (const file of files) hash.update(file.url).update(readFileSync(file.path))
const version = hash.digest('hex').slice(0, 16)

const precache = files.map((file) => file.url)
const header =
  `const PRECACHE = ${JSON.stringify(precache)}\n` + `const VERSION = ${JSON.stringify(version)}\n`
writeFileSync(join(PUBLIC_DIR, 'sw.js'), header + source)
console.log(`sw.js: version ${version}, ${precache.length} precached files`)
