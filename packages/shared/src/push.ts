/**
 * Web Push (roadmap 4.3, docs/architecture/push.md): shared payload rules,
 * api types and the client's availability decision.
 *
 * Push is only a hint (CLAUDE.md rule 3): the payload carries the event
 * type, the installation id of the receiving device and the badge count -
 * never subjects, senders, contents, account names or addresses (rule 4).
 * The app syncs itself after opening.
 */

/** The complete push payload; nothing else may be sent. */
export interface PushPayload {
  type: 'new_mail'
  /** `device.installation_id` of the receiving device. */
  installationId: string
  /** Unread INBOX messages across all accounts of the user. */
  badge: number
}

/** Field names a push payload may contain (tests assert this allowlist). */
export const PUSH_PAYLOAD_FIELDS = ['type', 'installationId', 'badge'] as const

export function buildPushPayload(installationId: string, badge: number): PushPayload {
  return {
    type: 'new_mail',
    installationId,
    badge: Number.isFinite(badge) && badge > 0 ? Math.floor(badge) : 0,
  }
}

/** `GET /api/push/vapid-public-key`; null when the instance has no VAPID keys. */
export interface VapidKeyResponse {
  publicKey: string | null
}

/** `POST /api/push/subscriptions` (the browser's PushSubscription JSON). */
export interface PushSubscriptionRequest {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

/** One push subscription as the api lists it (never the endpoint or keys). */
export interface PushSubscriptionInfo {
  id: string
  deviceId: string
  deviceName: string
  platform: string
  /** Subscription of the device making the request. */
  isCurrentDevice: boolean
  /** Host of the push service (e.g. web.push.apple.com), for display only. */
  pushService: string
  createdAt: string
  lastSuccessAt: string | null
}

/** `GET /api/push/subscriptions` */
export interface PushSubscriptionListResponse {
  subscriptions: PushSubscriptionInfo[]
}

/** What the push settings can offer on this client. */
export type PushAvailability =
  /** iOS/iPadOS in a browser tab: push only works after "Zum Home-Bildschirm". */
  | 'needs-install'
  | 'unsupported'
  /** The server has no VAPID keys configured. */
  | 'unconfigured'
  /** The user blocked notifications for this site. */
  | 'denied'
  | 'available'

export interface PushEnvironment {
  hasServiceWorker: boolean
  hasPushManager: boolean
  hasNotification: boolean
  isIos: boolean
  /** Running as installed app (display-mode standalone). */
  isStandalone: boolean
  permission: 'default' | 'granted' | 'denied' | null
  serverConfigured: boolean
}

export function pushAvailability(env: PushEnvironment): PushAvailability {
  // iOS Safari only exposes PushManager in the installed home screen app.
  if (env.isIos && !env.isStandalone) return 'needs-install'
  if (!env.hasServiceWorker || !env.hasPushManager || !env.hasNotification) return 'unsupported'
  if (!env.serverConfigured) return 'unconfigured'
  if (env.permission === 'denied') return 'denied'
  return 'available'
}

/** iPhone/iPod/iPad, including iPadOS that reports itself as a Mac. */
export function isIosUserAgent(userAgent: string, maxTouchPoints = 0): boolean {
  if (/iPhone|iPad|iPod/i.test(userAgent)) return true
  return /Macintosh/i.test(userAgent) && maxTouchPoints > 1
}

/** Decodes a base64url VAPID key into the bytes PushManager.subscribe() expects. */
export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
