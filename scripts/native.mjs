#!/usr/bin/env node
/**
 * Runs the app without Docker (ADR-0007, docs/operations/install-native.md):
 * needs Node, a PostgreSQL server and a prior `pnpm build`.
 *
 *   node scripts/native.mjs start          api (incl. PWA) + worker
 *   node scripts/native.mjs backup <args>  backup CLI, e.g. `create ./backups`
 *
 * Reads .env from the project root (scripts/setup-env.mjs) and fills in the
 * paths that the Docker images set themselves. Variables already set in the
 * environment win over .env.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const API_MAIN = join(ROOT, 'apps/api/dist/main.js')
const WORKER_MAIN = join(ROOT, 'apps/worker/dist/main.js')
const BACKUP_MAIN = join(ROOT, 'apps/worker/dist/backup.js')
const WEB_DIR = join(ROOT, 'apps/web/.output')

function fail(message) {
  console.error(`ERROR: ${message}`)
  process.exit(1)
}

function loadEnvironment() {
  const envPath = join(ROOT, '.env')
  if (existsSync(envPath)) process.loadEnvFile(envPath)
  if (!process.env.MASTER_KEY) {
    fail('MASTER_KEY is not set - run `node scripts/setup-env.mjs` first')
  }
  const env = { ...process.env }
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

function start() {
  requireBuild(API_MAIN, WORKER_MAIN, join(WEB_DIR, 'public/index.html'))
  const env = loadEnvironment()
  // Both run the migrations on startup; an advisory lock serializes them.
  const children = [
    ['api', API_MAIN],
    ['worker', WORKER_MAIN],
  ].map(([name, main]) => ({
    name,
    process: spawn(process.execPath, [main], { env, stdio: 'inherit' }),
  }))

  let stopping = false
  const stop = (signal) => {
    if (stopping) return
    stopping = true
    for (const child of children) child.process.kill(signal)
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop(signal))

  let exitCode = 0
  let running = children.length
  for (const child of children) {
    child.process.on('exit', (code, signal) => {
      // One process alone is no working instance: stop the other one too and
      // exit non-zero, so a supervisor (systemd) restarts both.
      if (!stopping) {
        console.error(`${child.name} exited (${signal ?? code}) - stopping`)
        exitCode = 1
        stop('SIGTERM')
      }
      running -= 1
      if (running === 0) process.exit(exitCode)
    })
  }
}

function backup(args) {
  requireBuild(BACKUP_MAIN)
  const env = loadEnvironment()
  const child = spawn(process.execPath, [BACKUP_MAIN, ...args], { env, stdio: 'inherit' })
  child.on('exit', (code) => process.exit(code ?? 1))
}

const [command = 'start', ...args] = process.argv.slice(2)
if (command === 'start') start()
else if (command === 'backup') backup(args)
else fail(`unknown command "${command}" (start | backup)`)
