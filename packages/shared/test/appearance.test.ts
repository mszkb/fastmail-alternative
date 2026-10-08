import { describe, expect, it } from 'vitest'
import { parseDensity, parseTheme, themeAttribute } from '../src/appearance'

describe('appearance', () => {
  it('parses stored choices with safe defaults', () => {
    expect(parseTheme('dark')).toBe('dark')
    expect(parseTheme('light')).toBe('light')
    expect(parseTheme('neon')).toBe('system')
    expect(parseTheme(null)).toBe('system')
    expect(parseDensity('compact')).toBe('compact')
    expect(parseDensity('tiny')).toBe('normal')
  })

  it('maps the theme to the daisyUI theme name', () => {
    expect(themeAttribute('light')).toBe('fma-light')
    expect(themeAttribute('dark')).toBe('fma-dark')
    expect(themeAttribute('system')).toBeNull()
  })
})
