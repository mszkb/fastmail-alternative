import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain ESM script without types
import { CSS_PATH, KOTLIN_PATH, TOKENS_PATH, cssMismatches, renderKotlin } from '../generate.mjs'

const tokens = JSON.parse(readFileSync(TOKENS_PATH, 'utf8'))

describe('design tokens (#141)', () => {
  it('the PWA themes use the token values', () => {
    expect(cssMismatches(tokens, readFileSync(CSS_PATH, 'utf8'))).toEqual([])
  })

  it('the generated Compose theme is up to date', () => {
    expect(readFileSync(KOTLIN_PATH, 'utf8')).toBe(renderKotlin(tokens))
  })

  it('reports a changed color', () => {
    const changed = structuredClone(tokens)
    changed.color.dark.primary = '#000000'
    expect(cssMismatches(changed, readFileSync(CSS_PATH, 'utf8'))).toEqual([
      'fma-dark --color-primary: css #5ea2f2, tokens #000000',
    ])
  })
})
