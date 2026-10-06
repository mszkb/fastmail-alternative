/**
 * Loads docs/api/openapi.yaml and validates responses against it with Ajv
 * (JSON Schema 2020-12, the dialect of OpenAPI 3.1).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js'
import { parse } from 'yaml'

export const SPEC_PATH = fileURLToPath(new URL('../../../docs/api/openapi.yaml', import.meta.url))

interface Operation {
  responses?: Record<string, { content?: Record<string, { schema?: unknown }>; $ref?: string }>
}
export interface Spec {
  paths: Record<string, Record<string, Operation>>
  components: { responses?: Record<string, { content?: Record<string, { schema?: unknown }> }> }
}

export const spec = parse(readFileSync(SPEC_PATH, 'utf8')) as Spec

const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false })
ajv.addSchema({ ...(spec as object), $id: 'openapi' })
const validators = new Map<string, ValidateFunction>()

/** OpenAPI path template matching a concrete path, e.g. /api/drafts/{id}. */
export function matchPath(path: string): string | undefined {
  const clean = path.split('?')[0]!
  if (spec.paths[clean]) return clean
  return Object.keys(spec.paths).find((template) => {
    const re = new RegExp(`^${template.replace(/\{[^}]+\}/g, '[^/]+')}$`)
    return re.test(clean)
  })
}

/**
 * Returns validation errors (empty = ok). Unknown paths and undocumented
 * status codes are errors; non-JSON bodies are only checked for a declared
 * status. 404 for a path that is not in the spec is the expected answer.
 */
export function validateResponse(
  method: string,
  path: string,
  status: number,
  body: unknown,
): string[] {
  // CSRF rejection (non-GET) and rate limits answer before routing on every
  // path; they are documented globally unless an operation lists them.
  const global = (status === 403 && method !== 'GET') || status === 429
  const template = matchPath(path)
  if (!template) return status === 404 || global ? [] : [`path ${path} is not in the spec`]
  const operation = spec.paths[template]?.[method.toLowerCase()]
  if (!operation) {
    return status === 404 || status === 405 || global
      ? []
      : [`${method} ${template} is not in the spec`]
  }
  let response = operation.responses?.[String(status)] ?? operation.responses?.default
  if (!response)
    return global ? [] : [`status ${status} is not documented for ${method} ${template}`]
  if (response.$ref) {
    const name = response.$ref.split('/').pop()!
    response = spec.components.responses?.[name] ?? {}
  }
  const schema = response.content?.['application/json']?.schema
  if (body === undefined || !schema) return []
  const key = `${method} ${template} ${status}`
  let validate = validators.get(key)
  if (!validate) {
    validate = ajv.compile({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      ...(rewriteRefs(schema) as object),
    })
    validators.set(key, validate)
  }
  if (validate(body)) return []
  return (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`)
}

/** `#/components/...` inside the spec -> `openapi#/components/...` for Ajv. */
function rewriteRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rewriteRefs)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        k === '$ref' && typeof v === 'string' && v.startsWith('#/')
          ? `openapi${v}`
          : rewriteRefs(v),
      ]),
    )
  }
  return value
}
