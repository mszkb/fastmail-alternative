// The spec covers exactly the routes of the backend (apps/server-php,
// ADR-0013). Runs without PHP or a database: the routes are read from the
// Slim route definitions (`$app->get('/api/...'` etc.) in the sources.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { spec } from '../src/openapi'

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
const SRC = join(import.meta.dirname, '../../../apps/server-php/src')

function phpFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? phpFiles(join(dir, entry.name))
      : entry.name.endsWith('.php')
        ? [join(dir, entry.name)]
        : [],
  )
}

/** "GET /api/messages/{id}" for every route; `{id:[0-9]+}` becomes `{id}`. */
function phpRoutes(): Set<string> {
  const routes = new Set<string>()
  for (const file of phpFiles(SRC)) {
    const source = readFileSync(file, 'utf8')
    for (const [, method, path] of source.matchAll(
      /->(get|post|put|patch|delete)\(\s*'(\/api[^']*)'/g,
    )) {
      routes.add(`${method!.toUpperCase()} ${path!.replace(/\{(\w+)[^}]*\}/g, '{$1}')}`)
    }
  }
  return routes
}

describe('OpenAPI spec vs. apps/server-php routes', () => {
  it('documents every route and no route that does not exist', () => {
    const routes = phpRoutes()
    expect(routes.size).toBeGreaterThan(50)
    const documented = new Set(
      Object.entries(spec.paths).flatMap(([path, item]) =>
        Object.keys(item)
          .filter((m) => METHODS.includes(m.toUpperCase()))
          .map((m) => `${m.toUpperCase()} ${path}`),
      ),
    )
    expect([...routes].filter((r) => !documented.has(r)).sort(), 'missing in the spec').toEqual([])
    expect([...documented].filter((r) => !routes.has(r)).sort(), 'not a route').toEqual([])
  })
})
