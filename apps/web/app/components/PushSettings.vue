<script setup lang="ts">
// Push notifications (roadmap 4.3, docs/architecture/push.md): explicit
// opt-in per device. Notification.requestPermission() runs directly in the
// click handler - iOS only asks inside a user gesture. On iOS/iPadOS push
// only exists in the installed home screen app, so a browser tab gets the
// install hint instead. Notifications carry no mail content; the app syncs
// after opening.
import { base64UrlToBytes, isIosUserAgent, pushAvailability } from '@fma/shared'
import type {
  PushAvailability,
  PushSubscriptionInfo,
  PushSubscriptionListResponse,
  VapidKeyResponse,
} from '@fma/shared'

const availability = ref<PushAvailability | 'loading'>('loading')
const subscribed = ref(false)
const subscriptions = ref<PushSubscriptionInfo[]>([])
const busy = ref(false)
const error = ref('')
let vapidKey: string | null = null
let registration: ServiceWorkerRegistration | null = null

async function request(path: string, options: RequestInit = {}): Promise<Response> {
  const res = await fetch(path, {
    ...options,
    headers: options.body ? { 'content-type': 'application/json' } : {},
  })
  if (!res.ok && res.status !== 404) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null
    throw new Error(body?.message ?? `Fehler ${res.status}`)
  }
  return res
}

async function loadSubscriptions(): Promise<void> {
  try {
    const res = await request('/api/push/subscriptions')
    subscriptions.value = ((await res.json()) as PushSubscriptionListResponse).subscriptions
  } catch {
    subscriptions.value = []
  }
}

async function saveSubscription(subscription: PushSubscription): Promise<void> {
  await request('/api/push/subscriptions', {
    method: 'POST',
    body: JSON.stringify(subscription.toJSON()),
  })
}

function detect(): PushAvailability {
  const nav = navigator as Navigator & { standalone?: boolean }
  return pushAvailability({
    hasServiceWorker: 'serviceWorker' in navigator,
    hasPushManager: 'PushManager' in window,
    hasNotification: 'Notification' in window,
    isIos: isIosUserAgent(navigator.userAgent, navigator.maxTouchPoints),
    isStandalone:
      window.matchMedia('(display-mode: standalone)').matches || nav.standalone === true,
    permission: 'Notification' in window ? Notification.permission : null,
    serverConfigured: vapidKey !== null,
  })
}

async function init(): Promise<void> {
  try {
    const res = await request('/api/push/vapid-public-key')
    vapidKey = ((await res.json()) as VapidKeyResponse).publicKey
  } catch {
    vapidKey = null
  }
  availability.value = detect()
  if (availability.value === 'available' || availability.value === 'denied') {
    // Not registered in development (see UpdatePrompt).
    registration = (await navigator.serviceWorker.getRegistration()) ?? null
    if (!registration) availability.value = 'unsupported'
  }
  if (registration && availability.value === 'available') {
    const existing = await registration.pushManager.getSubscription()
    subscribed.value = existing !== null && Notification.permission === 'granted'
    // Self-healing: re-report this browser's subscription (e.g. after a new
    // login, which creates a new device on the server).
    if (existing && subscribed.value) await saveSubscription(existing).catch(() => {})
  }
  await loadSubscriptions()
}

/** Click handler: the permission prompt must be the first thing it does. */
async function enable(): Promise<void> {
  if (busy.value || !registration || !vapidKey) return
  const permission = Notification.requestPermission()
  busy.value = true
  error.value = ''
  try {
    if ((await permission) !== 'granted') {
      availability.value = detect()
      error.value = 'Benachrichtigungen wurden nicht erlaubt.'
      return
    }
    // A subscription for an old server key would be rejected: start fresh.
    await (await registration.pushManager.getSubscription())?.unsubscribe()
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToBytes(vapidKey),
    })
    try {
      await saveSubscription(subscription)
    } catch (err) {
      await subscription.unsubscribe().catch(() => {})
      throw err
    }
    subscribed.value = true
    await loadSubscriptions()
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Aktivieren fehlgeschlagen.'
  } finally {
    busy.value = false
  }
}

async function disable(): Promise<void> {
  if (busy.value || !registration) return
  busy.value = true
  error.value = ''
  try {
    const subscription = await registration.pushManager.getSubscription()
    if (subscription) {
      await request('/api/push/subscriptions', {
        method: 'DELETE',
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      })
      await subscription.unsubscribe()
    }
    subscribed.value = false
    await loadSubscriptions()
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Deaktivieren fehlgeschlagen.'
  } finally {
    busy.value = false
  }
}

/** Device management: stop push for another device. */
async function remove(item: PushSubscriptionInfo): Promise<void> {
  if (item.isCurrentDevice) {
    await disable()
    return
  }
  busy.value = true
  error.value = ''
  try {
    await request(`/api/push/subscriptions/${item.id}`, { method: 'DELETE' })
    await loadSubscriptions()
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Entfernen fehlgeschlagen.'
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  void init()
})
</script>

<template>
  <div id="push" class="card push">
    <h2>Benachrichtigungen</h2>
    <p class="hint">
      Hinweis bei neuen E-Mails im Posteingang – ohne Betreff, Absender oder Inhalt. Die App lädt
      die Nachrichten erst nach dem Öffnen.
    </p>

    <p v-if="availability === 'loading'" class="hint">Wird geprüft &hellip;</p>
    <p v-else-if="availability === 'needs-install'" class="note">
      Auf iPhone und iPad funktionieren Benachrichtigungen nur in der installierten App: im
      Teilen-Menü „Zum Home-Bildschirm“ wählen, die App von dort öffnen und hier aktivieren.
      <a href="#install">Anleitung zur Installation</a>
    </p>
    <p v-else-if="availability === 'unsupported'" class="note">
      Dieser Browser unterstützt keine Push-Benachrichtigungen (oder der Service Worker ist nicht
      aktiv).
    </p>
    <p v-else-if="availability === 'unconfigured'" class="note">
      Auf dem Server sind keine VAPID-Schlüssel eingerichtet (siehe <code>.env</code>).
    </p>
    <p v-else-if="availability === 'denied'" class="note">
      Benachrichtigungen sind für diese Seite blockiert. Sie lassen sich in den Browser- bzw.
      Systemeinstellungen wieder erlauben.
    </p>
    <div v-else class="row">
      <span class="state" :class="{ on: subscribed }">
        {{ subscribed ? 'Auf diesem Gerät aktiv' : 'Auf diesem Gerät aus' }}
      </span>
      <button v-if="!subscribed" type="button" :disabled="busy" @click="enable">
        Benachrichtigungen aktivieren
      </button>
      <button v-else type="button" class="secondary" :disabled="busy" @click="disable">
        Deaktivieren
      </button>
    </div>

    <ul v-if="subscriptions.length > 0" class="subscriptions">
      <li v-for="item in subscriptions" :key="item.id">
        <span>
          <strong>{{ item.deviceName }}</strong>
          <span class="tag">{{ item.pushService }}</span>
          <span v-if="item.isCurrentDevice" class="tag current">dieses Gerät</span>
        </span>
        <button type="button" class="secondary" :disabled="busy" @click="remove(item)">
          Entfernen
        </button>
      </li>
    </ul>

    <p v-if="error" class="error">{{ error }}</p>
  </div>
</template>

<style scoped>
.card {
  display: block;
  padding: 1rem 1.25rem;
  margin-bottom: 1rem;
  border: 1px solid var(--fma-border);
  border-radius: 0.5rem;
  background: var(--color-base-200);
}

h2 {
  margin: 0 0 0.25rem;
  font-size: 1.1rem;
}

.hint {
  margin: 0 0 0.75rem;
  font-size: 0.85rem;
  color: var(--fma-muted);
}

.note {
  margin: 0;
  padding: 0.6rem 0.75rem;
  border-radius: 0.375rem;
  background: var(--fma-warning-soft);
  font-size: 0.9rem;
  color: var(--fma-warning-text);
}

.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.state {
  font-size: 0.9rem;
  color: var(--fma-muted);
}

.state.on {
  color: var(--color-success);
  font-weight: 600;
}

button {
  padding: 0.5rem 1rem;
  border: none;
  border-radius: 0.375rem;
  background: var(--color-primary);
  color: var(--color-primary-content);
  font: inherit;
  cursor: pointer;
}

button.secondary {
  background: var(--color-base-300);
  color: var(--color-base-content);
}

button:disabled {
  opacity: 0.6;
  cursor: wait;
}

.subscriptions {
  list-style: none;
  margin: 0.75rem 0 0;
  padding: 0;
}

.subscriptions li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.5rem 0;
  border-top: 1px solid var(--color-base-300);
}

.tag {
  display: inline-block;
  margin-left: 0.4rem;
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  background: var(--color-base-300);
  font-size: 0.75rem;
  color: var(--fma-muted);
}

.tag.current {
  background: var(--fma-success-soft);
  color: var(--color-success);
}

.error {
  margin: 0.75rem 0 0;
  font-size: 0.9rem;
  color: var(--color-error);
}
</style>
