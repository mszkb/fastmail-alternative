// Feature directory (#154): docs/product/features.yaml is the single list of
// features of the PWA and the native apps, with status and files per client
// and the logic both must keep in sync. This script renders
// docs/product/feature-matrix.md and validates the YAML: known statuses,
// unique ids, and every listed file or folder exists (stale paths fail CI).
// Usage: node packages/feature-matrix/generate.mjs [--check]
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { format } from 'prettier'
import { parse } from 'yaml'

const root = fileURLToPath(new URL('../../', import.meta.url))
export const YAML_PATH = `${root}docs/product/features.yaml`
export const MD_PATH = `${root}docs/product/feature-matrix.md`

const STATUS = { yes: '✅', partial: '🟨', no: '⬜', na: '–' }
const CLIENTS = ['web', 'app']

export function load(text = readFileSync(YAML_PATH, 'utf8')) {
  return parse(text)
}

/** Problems in the feature list, as readable lines (empty = valid). */
export function validate(doc, exists = (path) => existsSync(`${root}${path}`)) {
  const problems = []
  const ids = new Set()
  for (const feature of doc.features ?? []) {
    const where = feature.id ?? feature.name ?? '?'
    if (!feature.id || !feature.name || !feature.area)
      problems.push(`${where}: id, area and name are required`)
    if (ids.has(feature.id)) problems.push(`${where}: duplicate id`)
    ids.add(feature.id)
    for (const client of CLIENTS) {
      const entry = feature[client]
      if (!entry || !(entry.status in STATUS)) {
        problems.push(`${where}: ${client}.status must be one of ${Object.keys(STATUS).join(', ')}`)
        continue
      }
      if ((entry.status === 'yes' || entry.status === 'partial') && !(entry.files?.length > 0)) {
        problems.push(`${where}: ${client} is ${entry.status} but lists no files`)
      }
    }
    const paths = [
      ...(feature.web?.files ?? []),
      ...(feature.app?.files ?? []),
      ...(feature.logic ?? []),
      ...(feature.server ?? []),
    ]
    for (const path of paths) if (!exists(path)) problems.push(`${where}: path not found: ${path}`)
  }
  return problems
}

const link = (path) =>
  `[\`${path.replace(/^apps\/mobile\/[^/]+\/src\/[^/]+\/kotlin\/net\/fma\/mail\//, 'mobile/…/')}\`](../../${path})`
const cell = (entry) => {
  const files = (entry.files ?? []).map(link).join('<br>')
  const note = entry.note ? `<br>_${entry.note}_` : ''
  return `${STATUS[entry.status]} ${files}${note}`.trim()
}

/** The matrix as committed: rendered and formatted like the rest of the docs. */
export async function renderFormatted(doc) {
  return format(render(doc), {
    parser: 'markdown',
    filepath: MD_PATH,
    printWidth: 100,
    proseWrap: 'preserve',
  })
}

export function render(doc) {
  const lines = [
    '# Feature-Matrix Web ↔ App',
    '',
    '<!-- Generated from docs/product/features.yaml by packages/feature-matrix/generate.mjs - do not edit, run `pnpm features`. -->',
    '',
    'Ein Verzeichnis für beide Clients: welche Funktion es in der PWA (`apps/web`) und in der nativen App (`apps/mobile`) gibt, wo sie liegt und welche Logik in beiden gleich bleiben muss. Quelle ist [`features.yaml`](features.yaml); wer eine Funktion in einem Client ändert, trägt es dort ein (siehe `CLAUDE.md`). CI prüft, dass alle genannten Pfade existieren.',
    '',
    `Legende: ${STATUS.yes} vorhanden · ${STATUS.partial} teilweise · ${STATUS.no} fehlt · ${STATUS.na} nicht vorgesehen`,
    '',
  ]
  const counts = Object.fromEntries(CLIENTS.map((c) => [c, { yes: 0, partial: 0, no: 0, na: 0 }]))
  for (const feature of doc.features) for (const c of CLIENTS) counts[c][feature[c].status]++
  lines.push(
    `Stand: Web ${counts.web.yes} ✅ / ${counts.web.partial} 🟨 / ${counts.web.no} ⬜ · App ${counts.app.yes} ✅ / ${counts.app.partial} 🟨 / ${counts.app.no} ⬜ (von ${doc.features.length} Funktionen)`,
    '',
  )
  const areas = [...new Set(doc.features.map((f) => f.area))]
  for (const area of areas) {
    lines.push(
      `## ${area}`,
      '',
      '| Funktion | Web (PWA) | App (KMP) | Gleich halten (Logik) |',
      '| --- | --- | --- | --- |',
    )
    for (const f of doc.features.filter((x) => x.area === area)) {
      const name = `**${f.name}**${f.issues?.length ? ` (${f.issues.map((n) => `#${n}`).join(', ')})` : ''}${f.note ? `<br>${f.note}` : ''}`
      const logic = (f.logic ?? []).map(link).join('<br>') || '–'
      lines.push(`| ${name} | ${cell(f.web)} | ${cell(f.app)} | ${logic} |`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const doc = load()
  const problems = validate(doc)
  const markdown = await renderFormatted(doc)
  if (process.argv.includes('--check')) {
    const current = existsSync(MD_PATH) ? readFileSync(MD_PATH, 'utf8') : ''
    if (current !== markdown)
      problems.push('docs/product/feature-matrix.md is out of date: run pnpm features')
  } else {
    writeFileSync(MD_PATH, markdown)
  }
  if (problems.length > 0) {
    console.error(problems.join('\n'))
    process.exit(1)
  }
}
