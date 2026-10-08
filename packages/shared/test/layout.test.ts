import { describe, expect, it } from 'vitest'
import { LAYOUT_LIMITS, clampLayoutSize, parseLayout } from '../src/layout'

describe('mail layout', () => {
  it('falls back to defaults for missing or broken values', () => {
    expect(parseLayout(null)).toEqual({
      readingPane: 'right',
      folderWidth: LAYOUT_LIMITS.folderWidth.default,
      listWidth: LAYOUT_LIMITS.listWidth.default,
      listHeight: LAYOUT_LIMITS.listHeight.default,
    })
    expect(parseLayout('{not json').readingPane).toBe('right')
    expect(parseLayout('{"readingPane":"left"}').readingPane).toBe('right')
  })

  it('keeps valid values and clamps sizes', () => {
    const layout = parseLayout(
      JSON.stringify({
        readingPane: 'bottom',
        folderWidth: 50,
        listWidth: 500.4,
        listHeight: 5000,
      }),
    )
    expect(layout).toEqual({
      readingPane: 'bottom',
      folderWidth: LAYOUT_LIMITS.folderWidth.min,
      listWidth: 500,
      listHeight: LAYOUT_LIMITS.listHeight.max,
    })
    expect(parseLayout('{"readingPane":"off"}').readingPane).toBe('off')
    expect(clampLayoutSize('listWidth', Number.NaN)).toBe(LAYOUT_LIMITS.listWidth.default)
  })
})
