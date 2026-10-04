/**
 * Pull-to-refresh gesture (roadmap 4.8): pulling the message list down
 * from its top edge on a touch device starts a manual sync, like the
 * refresh button. Kept free of DOM access so it is testable; the view
 * feeds it the touch positions and whether the list is scrolled to the top.
 */

export interface PullToRefreshOptions {
  /** Pull distance (after damping) that triggers a refresh on release. */
  thresholdPx?: number
  /** The indicator never grows beyond this. */
  maxPx?: number
  /** Finger movement is scaled by this, so the list follows with resistance. */
  damping?: number
}

export class PullToRefresh {
  readonly thresholdPx: number
  private readonly maxPx: number
  private readonly damping: number
  private startY: number | null = null
  private distancePx = 0

  constructor(options: PullToRefreshOptions = {}) {
    this.thresholdPx = options.thresholdPx ?? 64
    this.maxPx = options.maxPx ?? 96
    this.damping = options.damping ?? 0.5
  }

  /** Current (damped) pull distance for the indicator. */
  get distance(): number {
    return this.distancePx
  }

  /** Whether releasing now would trigger a refresh. */
  get armed(): boolean {
    return this.distancePx >= this.thresholdPx
  }

  /** touchstart: a pull only starts when the list is at its top. */
  start(y: number, atTop: boolean): void {
    this.startY = atTop ? y : null
    this.distancePx = 0
  }

  /** touchmove: returns the new pull distance (0 when not pulling). */
  move(y: number): number {
    if (this.startY === null) return 0
    const delta = y - this.startY
    this.distancePx = delta > 0 ? Math.min(this.maxPx, delta * this.damping) : 0
    return this.distancePx
  }

  /** touchend/touchcancel: true when the pull should trigger a refresh. */
  end(): boolean {
    const trigger = this.startY !== null && this.armed
    this.startY = null
    this.distancePx = 0
    return trigger
  }
}

/**
 * Quiet hint after a manual sync request (refresh button/pull): `offline`
 * when the server could not be reached, otherwise the HTTP status of
 * POST /api/accounts/:id/sync. 429 (synced moments ago) is no error, and a
 * skipped sync (200: auth error, backoff ...) is explained by the account
 * status banner, so both only get a short note or none.
 */
export function manualSyncNotice(result: number | 'offline'): string | null {
  if (result === 'offline') return 'Offline – Aktualisieren nicht möglich.'
  if (result === 429) return 'Gerade aktualisiert.'
  if (result >= 200 && result < 300) return null
  return 'Aktualisieren fehlgeschlagen.'
}
