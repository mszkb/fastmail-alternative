import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  THEME_MAX_BYTES,
  parseThemeFile,
  themeStyleSheet,
  validateTheme,
  wantsDefaultTheme,
} from '../src/themes'

const valid = {
  format: 1,
  id: 'test-theme',
  name: 'Test',
  version: '1.0.0',
  author: 'Jemand',
  license: 'ISC',
  minAppVersion: '0.1.0',
  colors: { light: { primary: '#0b4f9c' }, dark: { 'base-100': '#101418' } },
  sizes: { radius: '0.25rem', 'text-md': '0.9rem' },
  layout: { readingPane: 'bottom', density: 'compact', accountRail: 'list' },
}

function errors(input: unknown): string[] {
  const result = validateTheme(input)
  return result.ok ? [] : result.errors
}

describe('validateTheme (#126)', () => {
  it('accepts a valid theme', () => {
    expect(validateTheme(valid)).toEqual({ ok: true, theme: valid, warnings: [] })
    expect(
      validateTheme({ ...valid, colors: undefined, sizes: undefined, layout: undefined }).ok,
    ).toBe(true)
  })

  it('rejects scripts, CSS, URLs and unknown fields', () => {
    expect(errors({ ...valid, css: 'body{}' })).toEqual(['Unbekanntes Feld „css“.'])
    expect(errors({ ...valid, colors: { light: { primary: 'url(https://x.test/a)' } } })).toEqual([
      '„colors.light.primary“ muss eine Farbe wie #1a2b3c sein.',
    ])
    expect(
      errors({ ...valid, colors: { light: { primary: 'red;background:url(x)' } } }),
    ).toHaveLength(1)
    expect(errors({ ...valid, colors: { light: { 'font-family': '#000000' } } })).toEqual([
      'Unbekannte Farbe „colors.light.font-family“.',
    ])
    expect(errors({ ...valid, sizes: { radius: 'calc(1rem + 1px)' } })).toHaveLength(1)
    expect(errors({ ...valid, sizes: { radius: '9rem' } })).toEqual([
      '„sizes.radius“ muss zwischen 0rem und 1.5rem liegen.',
    ])
    expect(errors({ ...valid, name: '<script>alert(1)</script>' })).toHaveLength(1)
    expect(errors({ ...valid, layout: { readingPane: 'left' } })).toEqual([
      '„layout.readingPane“: erlaubt sind right, bottom, off.',
    ])
    expect(errors({ ...valid, layout: { toolbar: 'x' } })).toHaveLength(1)
    // Inherited object keys are no allowed names.
    expect(errors({ ...valid, sizes: { constructor: '1rem' } })).toHaveLength(1)
    expect(errors({ ...valid, layout: { constructor: 'right' } })).toHaveLength(1)
    expect(errors({ ...valid, colors: { light: { primary: '#0b4f9c\n' } } })).toHaveLength(1)
    expect(errors({ ...valid, id: '../etc' })).toHaveLength(1)
    expect(errors({ ...valid, format: 2 })).toHaveLength(1)
    expect(errors({ ...valid, version: '1' })).toHaveLength(1)
    expect(errors([])).toHaveLength(1)
    // Errors never echo the rejected key verbatim.
    expect(errors({ ...valid, '<img src=x>': 1 })[0]).not.toContain('<')
  })

  it('accepts too little contrast with warnings', () => {
    const low = validateTheme({ ...valid, colors: { dark: { 'base-content': '#333333' } } })
    expect(low.ok).toBe(true)
    expect(low.ok && low.warnings[0]).toMatch(
      /^Zu wenig Kontrast \(dunkel\): base-content auf base-100/,
    )
    const light = validateTheme({ ...valid, colors: { light: { 'primary-content': '#1060c0' } } })
    expect(light.ok && light.warnings).toEqual([
      expect.stringMatching(/hell.*primary-content auf primary/),
    ])
  })

  it('limits the file size and needs JSON', () => {
    expect(parseThemeFile(JSON.stringify(valid)).ok).toBe(true)
    expect(parseThemeFile('{')).toEqual({
      ok: false,
      errors: ['Die Datei ist kein gültiges JSON.'],
    })
    const big = JSON.stringify({ ...valid, description: 'x'.repeat(THEME_MAX_BYTES) })
    expect(parseThemeFile(big)).toEqual({ ok: false, errors: ['Die Datei ist größer als 32 KB.'] })
  })

  it('writes only variables into the style sheet', () => {
    const css = themeStyleSheet(valid as never)
    expect(css).toBe(
      ':root[data-user-theme]{--color-primary:#0b4f9c;--fma-radius:0.25rem;--fma-text-md:0.9rem;}' +
        ':root[data-user-theme][data-theme=fma-dark]{--color-base-100:#101418;}' +
        '@media (prefers-color-scheme: dark){:root[data-user-theme]:not([data-theme=fma-light]){--color-base-100:#101418;}}',
    )
  })

  it('reads ?theme=default', () => {
    expect(wantsDefaultTheme('?theme=default')).toBe(true)
    expect(wantsDefaultTheme('?x=1')).toBe(false)
  })
})

describe('switcher presets (themes/)', () => {
  const dir = new URL('../../../themes/', import.meta.url)
  const files = readdirSync(dir).filter((f) => f.endsWith('.fmatheme.json'))

  it('are valid, AA in light and dark, and name no brand as their own', () => {
    expect(files).toHaveLength(3)
    for (const file of files) {
      const result = parseThemeFile(readFileSync(new URL(file, dir), 'utf8'))
      expect(result, file).toMatchObject({ ok: true, warnings: [] })
      if (!result.ok) continue
      expect(result.theme.name, file).toMatch(/\(wie (Gmail|Outlook|Fastmail)\)$/)
      expect(result.theme.description, file).toMatch(/keine Verbindung/)
    }
  })
})
