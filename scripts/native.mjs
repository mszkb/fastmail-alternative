#!/usr/bin/env node
/**
 * Runs the app without Docker (ADR-0007, docs/operations/install-native.md):
 * needs Node, a PostgreSQL server and a prior `pnpm build`.
 *
 *   node scripts/native.mjs start          api (incl. PWA) + worker
 *   node scripts/native.mjs backup <args>  backup CLI, e.g. `create ./backups`
 *
 * `start` runs api and worker in ONE node process to save memory (one
 * runtime instead of two). Docker keeps them in separate containers
 * (read-only mail volume for the api, separate memory limits).
 *
 * Reads .env from the project root (scripts/setup-env.mjs) and fills in the
 * paths that the Docker images set themselves. Variables already set in the
 * environment win over .env.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const API_SERVER = join(ROOT, 'apps/api/dist/server.js')
const WORKER_SERVICE = join(ROOT, 'apps/worker/dist/service.js')
const BACKUP_MAIN = join(ROOT, 'apps/worker/dist/backup.js')
const WEB_DIR = join(ROOT, 'apps/web/.output')

function fail(message) {
  console.error(`ERROR: ${message}`)
  process.exit(1)
}

/** Sets process.env; must run before the app bundles are imported (they read it on load). */
function loadEnvironment() {
  const envPath = join(ROOT, '.env')
  if (existsSync(envPath)) process.loadEnvFile(envPath)
  if (!process.env.MASTER_KEY) {
    fail('MASTER_KEY is not set - run `node scripts/setup-env.mjs` first')
  }
  const env = process.env
  env.NODE_ENV ??= 'production'
  env.MAIL_DATA_DIR = resolve(ROOT, env.MAIL_DATA_DIR ?? 'data/mail-data')
  env.WEB_DIR ??= WEB_DIR
  // Plain HTTP: only reachable from this machine unless the operator opts
  // in (HOST=0.0.0.0, e.g. for a test on the local network). TLS comes from
  // a reverse proxy such as caddy (see Caddyfile, API_UPSTREAM).
  env.HOST ??= '127.0.0.1'
  // mail-data holds encrypted mails only, but nobody else needs to list it.
  mkdirSync(env.MAIL_DATA_DIR, { recursive: true, mode: 0o700 })
  return env
}

function requireBuild(...files) {
  for (const file of files) {
    if (!existsSync(file)) fail(`${file} missing - run \`pnpm install && pnpm build\` first`)
  }
}

async function start() {
  requireBuild(API_SERVER, WORKER_SERVICE, join(WEB_DIR, 'public/index.html'))
  loadEnvironment()
  const { startApi, stopApi } = await import(pathToFileURL(API_SERVER).href)
  const { runWorker } = await import(pathToFileURL(WORKER_SERVICE).href)

  // The api runs the migrations before it listens; the worker starts after.
  const app = await startApi()
  const controller = new AbortController()
  let worker

  let stopping = false
  const shutdown = async (exitCode) => {
    if (stopping) return
    stopping = true
    controller.abort()
    // Running jobs finish first (like the worker container on SIGTERM).
    await Promise.allSettled([worker, stopApi(app)])
    process.exit(exitCode)
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void shutdown(0))

  // A worker that stops on its own leaves no working instance: stop the api
  // too and exit non-zero, so a supervisor (systemd) restarts everything.
  worker = runWorker(controller.signal).then(
    () => {
      if (!stopping) {
        console.error('worker stopped unexpectedly - shutting down')
        void shutdown(1)
      }
    },
    (err) => {
      console.error('worker crashed - shutting down:', err?.stack ?? String(err))
      void shutdown(1)
    },
  )
}

function backup(args) {
  requireBuild(BACKUP_MAIN)
  const env = loadEnvironment()
  const child = spawn(process.execPath, [BACKUP_MAIN, ...args], { env, stdio: 'inherit' })
  child.on('exit', (code) => process.exit(code ?? 1))
}

const [command = 'start', ...args] = process.argv.slice(2)
if (command === 'start')
  start().catch((err) => {
    console.error(err)
    process.exit(1)
  })
else if (command === 'backup') backup(args)
else fail(`unknown command "${command}" (start | backup)`)
