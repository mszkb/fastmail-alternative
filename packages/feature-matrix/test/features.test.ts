import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain ESM script without types
import { MD_PATH, load, renderFormatted, validate } from '../generate.mjs'

describe('feature matrix (#154)', () => {
  const doc = load()

  it('lists only existing files and valid statuses', () => {
    expect(validate(doc)).toEqual([])
  })

  it('the rendered matrix is up to date', async () => {
    expect(readFileSync(MD_PATH, 'utf8')).toBe(await renderFormatted(doc))
  })

  it('reports stale paths and missing statuses', () => {
    const broken = {
      features: [
        {
          id: 'x',
          area: 'A',
          name: 'X',
          web: { status: 'yes', files: ['nope/file.ts'] },
          app: { status: 'maybe' },
        },
      ],
    }
    expect(validate(broken, () => false)).toEqual([
      'x: app.status must be one of yes, partial, no, na',
      'x: path not found: nope/file.ts',
    ])
  })
})
