// The spec covers exactly the routes of the Node backend (apps/api); runs
// without a database (the app is only built, never queried).
import { describe, expect, it } from 'vitest'
import { buildApp } from '../../../apps/api/src/app'
import { spec } from '../src/openapi'

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

describe('OpenAPI spec vs. apps/api routes', () => {
  it('documents every route and no route that does not exist', async () => {
    const app = buildApp({ logger: false })
    const routes = new Set<string>()
    app.addHook('onRoute', (route) => {
      for (const method of [route.method].flat()) {
        if (METHODS.includes(method))
          routes.add(`${method} ${route.url.replace(/:(\w+)/g, '{$1}')}`)
      }
    })
    await app.ready()
    // Defined directly on the root instance before the hook was added.
    routes.add('GET /api/health')
    routes.add('GET /api/metrics')

    const documented = new Set(
      Object.entries(spec.paths).flatMap(([path, item]) =>
        Object.keys(item)
          .filter((m) => METHODS.includes(m.toUpperCase()))
          .map((m) => `${m.toUpperCase()} ${path}`),
      ),
    )
    expect([...routes].filter((r) => !documented.has(r)).sort(), 'missing in the spec').toEqual([])
    expect([...documented].filter((r) => !routes.has(r)).sort(), 'not a route').toEqual([])
    await app.close()
  })
})
