import { describe, expect, it } from 'vitest'
import { ForwardHistory, SwipeBack, hasUnsavedInput } from '../src/swipe-back'

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

describe('SwipeBack forward (swipe left)', () => {
  it('goes forward after a quick swipe to the left with a forward step', () => {
    const swipe = new SwipeBack({ forward: true })
    swipe.start(300, 300, 0, { canForward: true, width: 400 })
    expect(swipe.move(295, 302)).toBe(0) // below the slop: undecided
    expect(swipe.move(260, 305)).toBe(-40)
    expect(swipe.armed).toBe(false)
    expect(swipe.move(220, 305)).toBe(-80)
    expect(swipe.armed).toBe(true)
    expect(swipe.release(300)).toBe('forward')
    expect(swipe.distance).toBe(0)
  })

  it('only rubber-bands without a forward step and never triggers', () => {
    const swipe = new SwipeBack({ forward: true, rubberBandPx: 24 })
    swipe.start(300, 300, 0, { canForward: false })
    const small = swipe.move(260, 300)
    expect(small).toBeLessThan(0)
    const large = swipe.move(0, 300)
    expect(large).toBeLessThan(small) // still follows the finger a bit
    expect(large).toBeGreaterThan(-24) // but never beyond the band
    expect(swipe.armed).toBe(false)
    expect(swipe.release(100)).toBeNull()
  })

  it('keeps back working and reports it as "back"', () => {
    const swipe = new SwipeBack({ forward: true })
    swipe.start(100, 300, 0, { canForward: true })
    swipe.move(200, 300)
    expect(swipe.release(100)).toBe('back')
  })

  it('does not change direction after the axis lock', () => {
    const swipe = new SwipeBack({ forward: true })
    swipe.start(200, 300, 0, { canForward: true })
    swipe.move(180, 300) // locked: to the left
    expect(swipe.move(350, 300)).toBeCloseTo(0)
    expect(swipe.release(100)).toBeNull()
  })

  it('locks to vertical for a mostly vertical start', () => {
    const swipe = new SwipeBack({ forward: true })
    swipe.start(300, 300, 0, { canForward: true })
    expect(swipe.move(292, 320)).toBe(0)
    expect(swipe.move(100, 330)).toBe(0)
    expect(swipe.release(100)).toBeNull()
  })

  it('leaves the right screen edge to the system', () => {
    const swipe = new SwipeBack({ forward: true, edgeGuardPx: 20 })
    swipe.start(390, 300, 0, { canForward: true, width: 400 })
    expect(swipe.move(200, 300)).toBe(0)
    expect(swipe.release(100)).toBeNull()
    swipe.start(380, 300, 0, { canForward: true, width: 400 })
    swipe.move(200, 300)
    expect(swipe.release(100)).toBe('forward')
  })

  it('ignores the forward step unless enabled in the options', () => {
    const swipe = new SwipeBack()
    swipe.start(300, 300, 0, { canForward: true })
    expect(swipe.move(100, 300)).toBe(0)
    expect(swipe.release(100)).toBeNull()
  })

  it('does not trigger forward on a slow drag', () => {
    const swipe = new SwipeBack({ forward: true, maxDurationMs: 800 })
    swipe.start(300, 300, 0, { canForward: true })
    swipe.move(150, 300)
    expect(swipe.release(900)).toBeNull()
  })
})

describe('ForwardHistory', () => {
  it('is empty at first: no forward step', () => {
    const history = new ForwardHistory<string>()
    expect(history.canForward).toBe(false)
    expect(history.pop()).toBeUndefined()
  })

  it('redoes the most recent back step first, until the last one', () => {
    const history = new ForwardHistory<string>()
    history.push('message') // message -> list
    history.push('settings') // list -> ... (settings -> mail)
    expect(history.size).toBe(2)
    expect(history.pop()).toBe('settings')
    expect(history.pop()).toBe('message')
    // Past the last forward step: nothing more.
    expect(history.canForward).toBe(false)
    expect(history.pop()).toBeUndefined()
  })

  it('is cleared by a new navigation', () => {
    const history = new ForwardHistory<string>()
    history.push('message')
    history.clear()
    expect(history.canForward).toBe(false)
  })

  it('keeps only the most recent steps', () => {
    const history = new ForwardHistory<number>(2)
    history.push(1)
    history.push(2)
    history.push(3)
    expect(history.size).toBe(2)
    expect(history.pop()).toBe(3)
    expect(history.pop()).toBe(2)
    expect(history.pop()).toBeUndefined()
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
