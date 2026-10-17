/**
 * Swipe navigation (roadmap 4.9): a horizontal swipe to the right goes one
 * step back in the app (message -> list, settings -> mail); with
 * `forward: true` a swipe to the left goes one step forward again when the
 * app has a forward step, otherwise it only gives a small elastic
 * (rubber-band) movement and never triggers. Kept free of
 * DOM access so it is testable; the view feeds it the touch positions and
 * decides beforehand whether a gesture may start at all (inputs, text
 * selection, horizontally scrollable content, open composer).
 *
 * Defaults:
 * - Starts within `edgeGuardPx` (20 px) of the left screen edge are
 *   ignored: Safari in a browser tab reserves that area for its own
 *   history swipe, and leaving it alone avoids two competing gestures.
 *   Everywhere else the swipe works across the whole view.
 * - Axis lock: the direction is decided once the finger moved `slopPx`;
 *   a mostly vertical start is a scroll (or pull-to-refresh) and never
 *   becomes a swipe, so vertical scrolling stays untouched.
 * - Triggers on release after `thresholdPx` horizontally, within
 *   `maxDurationMs` (a slow drag is more likely reading than navigating).
 * - Starts within `edgeGuardPx` of the right edge are ignored as well when
 *   the viewport width is passed to `start` (Safari's forward swipe).
 */

export interface SwipeBackOptions {
  /** Horizontal distance that triggers "back" on release. */
  thresholdPx?: number
  /** Movement after which the axis (horizontal/vertical) is locked. */
  slopPx?: number
  /** Starts this close to the left screen edge are left to the system. */
  edgeGuardPx?: number
  /** Gestures taking longer than this do not trigger. */
  maxDurationMs?: number
  /** The progress indicator never grows beyond this. */
  maxPx?: number
  /** Track swipes to the left ("forward"); off by default. */
  forward?: boolean
  /** Largest elastic movement to the left without a forward step. */
  rubberBandPx?: number
}

export interface SwipeStartOptions {
  /** The app has a forward step (a left swipe may trigger). */
  canForward?: boolean
  /** Viewport width; enables the guard at the right edge. */
  width?: number
}

/** What a released swipe asks the app to do. */
export type SwipeAction = 'back' | 'forward' | null

type Axis = 'undecided' | 'horizontal' | 'vertical'

export class SwipeBack {
  readonly thresholdPx: number
  private readonly slopPx: number
  private readonly edgeGuardPx: number
  private readonly maxDurationMs: number
  private readonly maxPx: number
  private readonly forward: boolean
  private readonly rubberBandPx: number
  private canForward = false
  private start_: { x: number; y: number; t: number } | null = null
  private axis: Axis = 'undecided'
  private distancePx = 0
  // Direction of the locked horizontal swipe (true: to the left).
  private leftward = false

  constructor(options: SwipeBackOptions = {}) {
    this.thresholdPx = options.thresholdPx ?? 70
    this.slopPx = options.slopPx ?? 10
    this.edgeGuardPx = options.edgeGuardPx ?? 20
    this.maxDurationMs = options.maxDurationMs ?? 800
    this.maxPx = options.maxPx ?? 120
    this.forward = options.forward ?? false
    this.rubberBandPx = options.rubberBandPx ?? 24
  }

  /**
   * Current horizontal distance for an indicator: 0..maxPx to the right,
   * negative to the left (down to -maxPx, or -rubberBandPx without a
   * forward step).
   */
  get distance(): number {
    return this.distancePx
  }

  /** Whether releasing now would navigate (ignoring the duration). */
  get armed(): boolean {
    if (this.axis !== 'horizontal') return false
    if (this.distancePx >= this.thresholdPx) return true
    return this.canForward && -this.distancePx >= this.thresholdPx
  }

  /** touchstart: `x`/`y` in viewport pixels, `t` a timestamp in ms. */
  start(x: number, y: number, t: number, options: SwipeStartOptions = {}): void {
    const nearRight = options.width !== undefined && x > options.width - this.edgeGuardPx
    this.start_ = x < this.edgeGuardPx || nearRight ? null : { x, y, t }
    this.canForward = this.forward && (options.canForward ?? false)
    this.axis = 'undecided'
    this.distancePx = 0
  }

  /** Stops tracking the current touch (e.g. a second finger arrived). */
  cancel(): void {
    this.start_ = null
    this.axis = 'undecided'
    this.distancePx = 0
    this.leftward = false
  }

  /** touchmove: returns the new distance (0 when not swiping). */
  move(x: number, y: number): number {
    if (!this.start_ || this.axis === 'vertical') return 0
    const dx = x - this.start_.x
    const dy = y - this.start_.y
    if (this.axis === 'undecided') {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < this.slopPx) return 0
      // Mostly vertical (or to the left without `forward`): not a swipe.
      const horizontal = Math.abs(dx) > Math.abs(dy) && (dx > 0 || this.forward)
      this.axis = horizontal ? 'horizontal' : 'vertical'
      if (this.axis === 'vertical') return 0
      this.leftward = dx < 0
    }
    if (!this.leftward) {
      this.distancePx = Math.min(this.maxPx, Math.max(0, dx))
    } else if (this.canForward) {
      this.distancePx = -Math.min(this.maxPx, Math.max(0, -dx))
    } else {
      // Rubber band: the movement slows down and stops at rubberBandPx.
      const pull = Math.max(0, -dx)
      this.distancePx = -(this.rubberBandPx * pull) / (pull + this.rubberBandPx * 2)
    }
    return this.distancePx
  }

  /** touchend at time `t`: what the app should do (`null`: nothing). */
  release(t: number): SwipeAction {
    const trigger = this.start_ !== null && this.armed && t - this.start_.t <= this.maxDurationMs
    const action: SwipeAction = trigger ? (this.distancePx > 0 ? 'back' : 'forward') : null
    this.cancel()
    return action
  }

  /** touchend at time `t`: true when the app should go back. */
  end(t: number): boolean {
    return this.release(t) === 'back'
  }
}

/**
 * Forward steps for the swipe navigation, like a browser's forward
 * history: every swipe back records how to redo the step, a swipe forward
 * takes the most recent one, and any other navigation clears the list.
 * Bounded so a long back-and-forth never grows without limit.
 */
export class ForwardHistory<T> {
  private steps: T[] = []

  constructor(private readonly limit = 20) {}

  /** Number of forward steps available. */
  get size(): number {
    return this.steps.length
  }

  get canForward(): boolean {
    return this.steps.length > 0
  }

  /** After a step back: remembers how to go forward again. */
  push(step: T): void {
    this.steps.push(step)
    if (this.steps.length > this.limit) this.steps.shift()
  }

  /** The step to redo (most recent first), or undefined at the end. */
  pop(): T | undefined {
    return this.steps.pop()
  }

  /** A new navigation: there is no forward any more. */
  clear(): void {
    this.steps = []
  }
}

/** The parts of a form field needed to tell whether it holds unsaved input. */
export interface FormFieldState {
  type?: string
  value: string
  defaultValue: string
  checked?: boolean
  defaultChecked?: boolean
}

/**
 * True when any field differs from its initial state. A swipe "back" in
 * the settings unmounts the open form, so the view refuses it while this
 * is true. With v-model `defaultValue` stays empty, so callers pass the
 * value recorded before the first user interaction as `defaultValue`.
 */
export function hasUnsavedInput(fields: Iterable<FormFieldState>): boolean {
  for (const field of fields) {
    if (field.type === 'checkbox' || field.type === 'radio') {
      if (Boolean(field.checked) !== Boolean(field.defaultChecked)) return true
    } else if (field.value !== field.defaultValue) {
      return true
    }
  }
  return false
}
