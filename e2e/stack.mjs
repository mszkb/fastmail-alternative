// Local stack for the browser tests (#74): empties the e2e database, starts
// the PHP backend (apps/server-php: `php -S` for the api, bin/worker.php)
// and serves the generated PWA (`pnpm build` first) with an /api proxy,
// like caddy + nginx in docker compose. Also usable by hand:
// `node e2e/stack.mjs`, then open http://127.0.0.1:4173.
//
// Needs PHP >= 8.2 with pdo_mysql (`composer install` in apps/server-php),
// DATABASE_URL (mysql://..., a database this script may wipe) and GreenMail
// reachable from api/worker; MAIL_ALLOW_PRIVATE_HOSTS and
// MAIL_INSECURE_TRANSPORT are set here because GreenMail has no TLS.
//
// API_CMD and WORKER_CMD override the commands (both run through `sh -c`
// from the repository root; the api gets HOST and PORT and must listen
// there). WORKER_CMD may be empty (no worker). DB_RESET_CMD replaces the
// built-in reset (drop every table of the DATABASE_URL database).
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PUBLIC_DIR = join(ROOT, 'apps/web/.output/public')
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 4173)
const API_PORT = Number(process.env.E2E_API_PORT ?? 3101)
// Migrations first; several php -S workers so polling and uploads run in parallel.
const API_CMD =
  process.env.API_CMD ??
  'php apps/server-php/bin/migrate.php && PHP_CLI_SERVER_WORKERS=4 exec php -S "$HOST:$PORT" -t apps/server-php/public apps/server-php/public/index.php'
// The delay lets the api apply the migrations before the worker starts.
const WORKER_CMD = process.env.WORKER_CMD ?? 'sleep 3; exec php apps/server-php/bin/worker.php'
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required (the database is wiped)')
for (const file of ['apps/web/.output', 'apps/server-php/vendor']) {
  if (!existsSync(join(ROOT, file))) {
    throw new Error(`${file} missing - run pnpm build and composer install (apps/server-php) first`)
  }
}

// Drops every table of the database in DATABASE_URL (mysql://user:pass@host:port/db).
const RESET_PHP = `
$u = parse_url(getenv('DATABASE_URL'));
$pdo = new PDO(sprintf('mysql:host=%s;port=%d;dbname=%s', $u['host'], $u['port'] ?? 3306, ltrim($u['path'], '/')),
  urldecode($u['user'] ?? ''), urldecode($u['pass'] ?? ''), [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
$pdo->exec('SET FOREIGN_KEY_CHECKS = 0');
foreach ($pdo->query('SHOW FULL TABLES WHERE Table_type = "BASE TABLE"')->fetchAll(PDO::FETCH_COLUMN) as $t) {
  $pdo->exec('DROP TABLE \`' . str_replace('\`', '\`\`', $t) . '\`');
}`
const reset = process.env.DB_RESET_CMD
  ? spawnSync('sh', ['-c', process.env.DB_RESET_CMD], { cwd: ROOT, stdio: 'inherit' })
  : spawnSync('php', ['-r', RESET_PHP], { cwd: ROOT, stdio: 'inherit' })
if (reset.status !== 0) throw new Error('resetting the e2e database failed')

const dataDir = mkdtempSync(join(tmpdir(), 'fma-e2e-'))
const env = {
  ...process.env,
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
