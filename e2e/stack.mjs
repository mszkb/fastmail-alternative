// Local stack for the browser tests (#74): resets the e2e database, starts
// the built api and worker (`pnpm build` first) and serves the generated PWA
// with an /api proxy, like caddy + nginx in docker compose. Also usable by
// hand: `node e2e/stack.mjs`, then open http://127.0.0.1:4173.
//
// Needs DATABASE_URL (a database this script may wipe) and GreenMail
// reachable from the api/worker; MAIL_ALLOW_PRIVATE_HOSTS and
// MAIL_INSECURE_TRANSPORT are set here because GreenMail has no TLS.
//
// Other backends (ADR-0013, #96): API_CMD and WORKER_CMD replace the Node
// api and worker. Both run through `sh -c` from the repository root; the
// api command gets HOST and PORT in its environment and must listen there,
// e.g. for the PHP backend:
//   API_CMD='php apps/server-php/bin/migrate.php && exec php -S "$HOST:$PORT" -t apps/server-php/public apps/server-php/public/index.php'
// WORKER_CMD may be empty (no worker). A non-PostgreSQL DATABASE_URL needs
// DB_RESET_CMD, a shell command that empties the database.
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PUBLIC_DIR = join(ROOT, 'apps/web/.output/public')
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 4173)
const API_PORT = Number(process.env.E2E_API_PORT ?? 3101)
const API_CMD = process.env.API_CMD ?? 'exec node apps/api/dist/main.js'
const WORKER_CMD = process.env.WORKER_CMD ?? 'exec node apps/worker/dist/main.js'
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required (the database is wiped)')
const required = ['apps/web/.output']
if (process.env.API_CMD === undefined) required.push('apps/api/dist/main.js')
if (process.env.WORKER_CMD === undefined) required.push('apps/worker/dist/main.js')
for (const file of required) {
  if (!existsSync(join(ROOT, file))) throw new Error(`${file} missing - run pnpm build first`)
}

if (process.env.DB_RESET_CMD) {
  const reset = spawnSync('sh', ['-c', process.env.DB_RESET_CMD], { cwd: ROOT, stdio: 'inherit' })
  if (reset.status !== 0) throw new Error('DB_RESET_CMD failed')
} else if (/^postgres(ql)?:/.test(databaseUrl)) {
  const pool = new pg.Pool({ connectionString: databaseUrl })
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await pool.end()
} else {
  throw new Error('DB_RESET_CMD is required for a non-PostgreSQL DATABASE_URL')
}

const dataDir = mkdtempSync(join(tmpdir(), 'fma-e2e-'))
const env = {
  ...process.env,
  NODE_ENV: 'production',
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
  MASTER_KEY: process.env.MASTER_KEY ?? randomBytes(32).toString('base64'),
  SETUP_TOKEN: process.env.SETUP_TOKEN ?? 'e2e-setup-code',
  MAIL_DATA_DIR: dataDir,
  MAIL_ALLOW_PRIVATE_HOSTS: '1',
  MAIL_INSECURE_TRANSPORT: '1',
  SYNC_INTERVAL_SECONDS: '15',
  SYNC_MIN_INTERVAL_SECONDS: '0',
}
const children = [
  spawn('sh', ['-c', API_CMD], {
    cwd: ROOT,
    env: { ...env, HOST: '127.0.0.1', PORT: String(API_PORT) },
    stdio: 'inherit',
  }),
]
if (WORKER_CMD !== '') {
  children.push(spawn('sh', ['-c', WORKER_CMD], { cwd: ROOT, env, stdio: 'inherit' }))
}
function stop() {
  for (const child of children) child.kill('SIGTERM')
  rmSync(dataDir, { recursive: true, force: true })
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
for (const child of children) {
  child.on('exit', (code) => {
    console.error(`e2e stack: child exited with ${code}`)
    stop()
  })
}

// Same security headers as nginx (apps/web/scripts/build-csp.mjs), so CSP
// problems show up in the tests too. Read per request: a rebuild changes
// the script hashes.
const securityHeaders = () =>
  [
    ...readFileSync(join(ROOT, 'apps/web/.output/security-headers.conf'), 'utf8').matchAll(
      /add_header\s+(\S+)\s+"((?:[^"\\]|\\.)*)"/g,
    ),
  ].map((match) => [match[1], match[2]])
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

createServer((req, res) => {
  if (req.url?.startsWith('/api/')) {
    // Host stays unchanged: the api compares it with Origin (CSRF check).
    const upstream = request(
      {
        host: '127.0.0.1',
        port: API_PORT,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers)
        response.pipe(res)
      },
    )
    upstream.on('error', () => res.writeHead(502).end())
    req.pipe(upstream)
    return
  }
  const pathname = normalize(decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname))
  let file = join(PUBLIC_DIR, pathname)
  if (!file.startsWith(PUBLIC_DIR) || !existsSync(file) || pathname.endsWith('/')) {
    file = join(PUBLIC_DIR, 'index.html')
  }
  for (const [name, value] of securityHeaders()) res.setHeader(name, value)
  res.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream')
  res.end(readFileSync(file))
}).listen(WEB_PORT, '127.0.0.1', () => {
  console.log(`e2e stack: http://127.0.0.1:${WEB_PORT} (api on ${API_PORT})`)
})
