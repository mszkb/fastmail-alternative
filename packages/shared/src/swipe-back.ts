/**
 * Swipe navigation (roadmap 4.9): a horizontal swipe to the right goes one
 * step back in the app (message -> list, settings -> mail). Kept free of
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
 * - Only "back" (to the right); the app has no forward history.
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
}

type Axis = 'undecided' | 'horizontal' | 'vertical'

export class SwipeBack {
  readonly thresholdPx: number
  private readonly slopPx: number
  private readonly edgeGuardPx: number
  private readonly maxDurationMs: number
  private readonly maxPx: number
  private start_: { x: number; y: number; t: number } | null = null
  private axis: Axis = 'undecided'
  private distancePx = 0

  constructor(options: SwipeBackOptions = {}) {
    this.thresholdPx = options.thresholdPx ?? 70
    this.slopPx = options.slopPx ?? 10
    this.edgeGuardPx = options.edgeGuardPx ?? 20
    this.maxDurationMs = options.maxDurationMs ?? 800
    this.maxPx = options.maxPx ?? 120
  }

  /** Current horizontal distance (0..maxPx) for an indicator. */
  get distance(): number {
    return this.distancePx
  }

  /** Whether releasing now would go back (ignoring the duration). */
  get armed(): boolean {
    return this.axis === 'horizontal' && this.distancePx >= this.thresholdPx
  }

  /** touchstart: `x`/`y` in viewport pixels, `t` a timestamp in ms. */
  start(x: number, y: number, t: number): void {
    this.start_ = x < this.edgeGuardPx ? null : { x, y, t }
    this.axis = 'undecided'
    this.distancePx = 0
  }

  /** Stops tracking the current touch (e.g. a second finger arrived). */
  cancel(): void {
    this.start_ = null
    this.axis = 'undecided'
    this.distancePx = 0
  }

  /** touchmove: returns the new distance (0 when not swiping). */
  move(x: number, y: number): number {
    if (!this.start_ || this.axis === 'vertical') return 0
    const dx = x - this.start_.x
    const dy = y - this.start_.y
    if (this.axis === 'undecided') {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < this.slopPx) return 0
      // Mostly vertical or to the left: not a back swipe, for this touch.
      this.axis = dx > 0 && Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical'
      if (this.axis === 'vertical') return 0
    }
    this.distancePx = Math.min(this.maxPx, Math.max(0, dx))
    return this.distancePx
  }

  /** touchend/touchcancel at time `t`: true when the app should go back. */
  end(t: number): boolean {
    const trigger = this.start_ !== null && this.armed && t - this.start_.t <= this.maxDurationMs
    this.cancel()
    return trigger
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
 * is true. Fields filled through v-model count as changed (their
 * `defaultValue` stays empty), which errs on the side of keeping input.
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
