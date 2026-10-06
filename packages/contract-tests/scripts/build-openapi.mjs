// Merges docs/api/parts/*.yaml into docs/api/openapi.yaml (#96).
// _base.yaml carries info, security and shared components; every other part
// contributes `paths` and `components.schemas`. Duplicate paths/operations
// or conflicting schemas fail the build.
// Usage: node packages/contract-tests/scripts/build-openapi.mjs [--check]
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { fileURLToPath } from 'node:url'
import { parse, stringify } from 'yaml'

const dir = fileURLToPath(new URL('../../../docs/api/', import.meta.url))
const spec = parse(readFileSync(`${dir}parts/_base.yaml`, 'utf8'))
spec.paths = {}
for (const file of readdirSync(`${dir}parts`)
  .filter((f) => f.endsWith('.yaml') && f !== '_base.yaml')
  .sort()) {
  const part = parse(readFileSync(`${dir}parts/${file}`, 'utf8'))
  for (const [path, item] of Object.entries(part.paths ?? {})) {
    spec.paths[path] ??= {}
    for (const [method, op] of Object.entries(item)) {
      if (spec.paths[path][method]) throw new Error(`${file}: duplicate ${method} ${path}`)
      spec.paths[path][method] = op
    }
  }
  for (const [name, schema] of Object.entries(part.components?.schemas ?? {})) {
    const existing = spec.components.schemas[name]
    if (existing && !isDeepStrictEqual(existing, schema))
      throw new Error(`${file}: conflicting schema ${name}`)
    spec.components.schemas[name] = schema
  }
}
spec.paths = Object.fromEntries(Object.entries(spec.paths).sort(([a], [b]) => a.localeCompare(b)))
const out =
  '# Generated from docs/api/parts/*.yaml by packages/contract-tests/scripts/build-openapi.mjs - edit the parts.\n' +
  stringify(spec, { lineWidth: 0 })
if (process.argv.includes('--check')) {
  if (readFileSync(`${dir}openapi.yaml`, 'utf8') !== out) {
    console.error(
      'docs/api/openapi.yaml is outdated: run node packages/contract-tests/scripts/build-openapi.mjs',
    )
    process.exit(1)
  }
} else {
  writeFileSync(`${dir}openapi.yaml`, out)
}
