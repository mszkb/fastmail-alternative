// Design tokens (#141): generated files current, palettes valid, icon list complete.
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const tokens = JSON.parse(
  readFileSync(join(root, 'packages/design-tokens/tokens.json'), 'utf8'),
) as {
  colors: Record<'light' | 'dark', Record<string, string>>
  accountColors: { name: string; value: string }[]
  icons: { names: string[] }
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

/** Every `.vue`/`.ts` file below a directory. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sources(join(dir, entry.name))
      : /\.(vue|ts)$/.test(entry.name)
        ? [join(dir, entry.name)]
        : [],
  )
}

describe('design tokens', () => {
  it('generated files are up to date (pnpm tokens)', () => {
    const script = join(root, 'packages/design-tokens/scripts/build.mjs')
    const result = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })

  it('light and dark define the same colors, all #rrggbb', () => {
    expect(Object.keys(tokens.colors.dark)).toEqual(Object.keys(tokens.colors.light))
    for (const palette of Object.values(tokens.colors)) {
      for (const value of Object.values(palette)) expect(value).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it('white initials stay readable on every account color (WCAG AA)', () => {
    for (const { name, value } of tokens.accountColors) {
      expect(contrast('#ffffff', value), name).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('lists exactly the icons the PWA uses', () => {
    const used = new Set<string>()
    for (const file of sources(join(root, 'apps/web/app'))) {
      const text = readFileSync(file, 'utf8')
      for (const [, names] of text.matchAll(
        /import\s*\{([^}]*)\}\s*from\s*'@tabler\/icons-vue'/g,
      )) {
        for (const name of names!.split(',').map((n) => n.trim().split(/\s+as\s+/)[0]!)) {
          if (!name.startsWith('Icon')) continue
          // IconMenu2 -> menu-2, IconFlagFilled -> flag-filled
          used.add(
            name
              .slice(4)
              .replace(/([a-z])([A-Z0-9])/g, '$1-$2')
              .toLowerCase(),
          )
        }
      }
    }
    expect(used.size).toBeGreaterThan(0)
    expect([...used].sort()).toEqual([...tokens.icons.names].sort())
  })
})
