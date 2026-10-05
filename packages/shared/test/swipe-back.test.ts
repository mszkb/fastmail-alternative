import { describe, expect, it } from 'vitest'
import { SwipeBack, hasUnsavedInput } from '../src/swipe-back'

describe('SwipeBack', () => {
  it('goes back after a quick horizontal swipe to the right', () => {
    const swipe = new SwipeBack()
    swipe.start(100, 300, 0)
    expect(swipe.move(105, 302)).toBe(0) // below the slop: undecided
    expect(swipe.move(140, 305)).toBe(40)
    expect(swipe.armed).toBe(false)
    expect(swipe.move(180, 310)).toBe(80)
    expect(swipe.armed).toBe(true)
    expect(swipe.end(300)).toBe(true)
    expect(swipe.distance).toBe(0)
  })

  it('does not trigger below the threshold', () => {
    const swipe = new SwipeBack({ thresholdPx: 70 })
    swipe.start(100, 300, 0)
    swipe.move(160, 300)
    expect(swipe.end(100)).toBe(false)
  })

  it('locks to vertical when the first movement is mostly vertical', () => {
    const swipe = new SwipeBack()
    swipe.start(100, 300, 0)
    expect(swipe.move(108, 320)).toBe(0)
    // Later horizontal movement does not turn the scroll into a swipe.
    expect(swipe.move(300, 330)).toBe(0)
    expect(swipe.armed).toBe(false)
    expect(swipe.end(200)).toBe(false)
  })

  it('ignores swipes to the left (no forward history)', () => {
    const swipe = new SwipeBack()
    swipe.start(300, 300, 0)
    expect(swipe.move(280, 300)).toBe(0)
    expect(swipe.move(100, 300)).toBe(0)
    expect(swipe.end(100)).toBe(false)
  })

  it('leaves the left screen edge to the system', () => {
    const swipe = new SwipeBack({ edgeGuardPx: 20 })
    swipe.start(10, 300, 0)
    expect(swipe.move(200, 300)).toBe(0)
    expect(swipe.end(100)).toBe(false)
    swipe.start(20, 300, 0)
    swipe.move(200, 300)
    expect(swipe.end(100)).toBe(true)
  })

  it('does not trigger on a slow drag', () => {
    const swipe = new SwipeBack({ maxDurationMs: 800 })
    swipe.start(100, 300, 0)
    swipe.move(250, 300)
    expect(swipe.end(801)).toBe(false)
    swipe.start(100, 300, 1000)
    swipe.move(250, 300)
    expect(swipe.end(1800)).toBe(true)
  })

  it('caps the distance, clamps back-tracking and can be cancelled', () => {
    const swipe = new SwipeBack({ maxPx: 120 })
    swipe.start(100, 300, 0)
    expect(swipe.move(600, 300)).toBe(120)
    expect(swipe.move(50, 300)).toBe(0)
    swipe.move(250, 300)
    swipe.cancel()
    expect(swipe.distance).toBe(0)
    expect(swipe.end(100)).toBe(false)
  })

  it('does nothing without a start', () => {
    const swipe = new SwipeBack()
    expect(swipe.move(300, 300)).toBe(0)
    expect(swipe.end(0)).toBe(false)
  })
})

describe('hasUnsavedInput', () => {
  it('is false for untouched fields', () => {
    expect(
      hasUnsavedInput([
        { type: 'text', value: '', defaultValue: '' },
        {
          type: 'checkbox',
          value: 'on',
          defaultValue: 'on',
          checked: false,
          defaultChecked: false,
        },
      ]),
    ).toBe(false)
  })

  it('is true once a text field or a checkbox changed', () => {
    expect(hasUnsavedInput([{ type: 'password', value: 'secret', defaultValue: '' }])).toBe(true)
    expect(
      hasUnsavedInput([
        { type: 'checkbox', value: 'on', defaultValue: 'on', checked: true, defaultChecked: false },
      ]),
    ).toBe(true)
  })

  it('is false without fields', () => {
    expect(hasUnsavedInput([])).toBe(false)
  })
})
