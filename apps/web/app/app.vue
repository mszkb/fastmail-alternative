<script setup lang="ts">
// Auth UI (roadmap 1.6), mail view (roadmap 2.3) and settings with account
// management (roadmap 2.1/3.1), devices and password change. The account
// list (with unread counts for the switcher, 3.2) is refreshed periodically
// and on focus.
// Sync on start and focus (4.5, push-independent): on start, when the app
// becomes visible/focused again and when it comes back online, it asks the
// server to sync all accounts (POST /api/sync) and then polls the account
// list every few seconds while a sync runs (ForegroundSyncPolicy from
// @fma/shared); MailView reloads its data when the active account changed.
// Push (4.3): opt-in in the settings (PushSettings); a click on a
// notification focuses the app and the service worker asks it to sync.
// Badge (4.4): the unread INBOX total of all accounts goes to the app icon
// (Badging API) or the title prefix whenever the account list refreshes.
// Install hints (4.2): banner in a browser tab, guide in the settings.
// Offline-first (4.6): the account list and the session marker are cached
// (encrypted IndexedDB, utils/offline-store.ts). Without a server the app
// starts from that cache ("Offline" badge) and checks the session again as
// soon as it is back online; queued actions (utils/offline-queue.ts) are
// replayed first, then the usual sync runs. Logout, an expired or revoked
// session (401) or another user clear all offline data on this device.
// Sync status (#119): after a refresh shows a sync, GET /api/sync/status is
// polled every 2.5 s while any account's sync is queued, running or
// stopping, and not afterwards; when an account's sync ends, the account
// list is reloaded (the views refresh as in 4.5). "Stoppen" posts the
// cancel and shows "wird gestoppt" right away. A backend without the
// endpoint (404, the Node backend) keeps the 4.5 behavior: the state comes
// from `syncing`, the account list is polled, there is no stop button.
import {
  ForegroundSyncPolicy,
  SwipeBack,
  finishedSyncs,
  hasUnsavedInput,
  isSyncActive,
  nextSyncStatusPoll,
  onlyQueuedSyncs,
  syncStatusFromAccounts,
  unreadBadgeCount,
} from '@fma/shared'
import type {
  AccountListResponse,
  AccountSummary,
  AccountSyncStatus,
  SyncStatusResponse,
  UserSettings,
} from '@fma/shared'
import {
  clearOfflineData,
  cacheDeleteAccount,
  cacheGet,
  cachePut,
  enableOfflineData,
} from '~/utils/offline-store'
import {
  dismissNotice,
  isOffline,
  loadQueue,
  offlineState,
  onUnauthorized,
  pendingCount,
  pendingText,
  replayQueue,
  resetOfflineState,
} from '~/utils/offline-queue'

interface AuthStatus {
  needsSetup: boolean
  authenticated: boolean
  email?: string
}

interface DeviceInfo {
  id: string
  name: string
  platform: string
  lastSeenAt: string | null
  isCurrent: boolean
}

const view = ref<'loading' | 'setup' | 'login' | 'app'>('loading')
const section = ref<'mail' | 'settings'>('mail')
const email = ref('')
const password = ref('')
const deviceName = ref('')
const setupCode = ref('')
const busy = ref(false)
const error = ref('')
const info = ref('')
const currentEmail = ref('')
const devices = ref<DeviceInfo[]>([])
const accounts = ref<AccountSummary[]>([])
// Account whose edit form is open in the settings.
const editAccountId = ref('')

const ACCOUNT_REFRESH_MS = 60_000
const SESSION_KEY = 'session'
const ACCOUNTS_KEY = 'accounts'
// False while the app runs from the cache without having reached the
// server: the session is checked again before anything else is sent.
let sessionVerified = false
let accountTimer: ReturnType<typeof setInterval> | undefined
let pollTimer: ReturnType<typeof setTimeout> | undefined
const syncPolicy = new ForegroundSyncPolicy()
// Sync status (#119); supported: null = not asked yet, false = 404 (Node).
const syncStatus = ref<AccountSyncStatus[]>([])
const syncStatusSupported = ref<boolean | null>(null)
let statusTimer: ReturnType<typeof setTimeout> | undefined
let statusLoading = false
// Bumped by a stop: a status response requested before it is outdated.
let statusEpoch = 0
// Since when all active syncs only wait (slower polling after a while).
let onlyQueuedSince: number | null = null

// Swipe navigation (4.9): a swipe to the right goes one step back
// (message -> list, account form -> settings, settings -> mail). The
// gesture logic lives in SwipeBack (@fma/shared); listeners are passive,
// so scrolling is never delayed.
const mailView = ref<{
  goBack: () => boolean
  openFromUnified: (accountId: string, messageId: string) => Promise<void>
} | null>(null)
const swipe = new SwipeBack()
const swipeDistance = ref(0)
const swipeArmed = ref(false)

/** Elements whose own horizontal gestures must win over the swipe. */
function swipeAllowedFrom(target: EventTarget | null): boolean {
  if (view.value !== 'app') return false
  const selection = window.getSelection()
  if (selection && !selection.isCollapsed) return false
  let element = target instanceof Element ? target : null
  if (
    element?.closest('input, textarea, select, [contenteditable], dialog[open], .compose-backdrop')
  ) {
    return false
  }
  for (; element && element !== document.body; element = element.parentElement) {
    if (element.scrollWidth > element.clientWidth) {
      const overflow = getComputedStyle(element).overflowX
      if (overflow === 'auto' || overflow === 'scroll') return false
    }
  }
  return true
}

function onSwipeStart(event: TouchEvent): void {
  const touch = event.touches[0]
  if (!touch || event.touches.length > 1 || !swipeAllowedFrom(event.target)) {
    swipe.cancel()
    swipeDistance.value = 0
    return
  }
  swipe.start(touch.clientX, touch.clientY, event.timeStamp)
}

function onSwipeMove(event: TouchEvent): void {
  const touch = event.touches[0]
  if (!touch) return
  swipeDistance.value = swipe.move(touch.clientX, touch.clientY)
  swipeArmed.value = swipe.armed
}

function onSwipeEnd(event: TouchEvent): void {
  const trigger = swipe.end(event.timeStamp)
  swipeDistance.value = 0
  swipeArmed.value = false
  if (trigger) goBack()
}

/** A cancelled touch (e.g. system gesture) never navigates. */
function onSwipeCancel(): void {
  swipe.cancel()
  swipeDistance.value = 0
  swipeArmed.value = false
}

// Value of each settings field before the user first touched/focused it.
// v-model leaves `defaultValue` empty, so this baseline is what "unsaved"
// is measured against; fields never interacted with count as unchanged.
const fieldBaseline = new WeakMap<Element, { value: string; checked: boolean }>()

function recordFieldBaseline(event: Event): void {
  const field = event.target
  if (
    (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) &&
    field.closest('.settings') &&
    !fieldBaseline.has(field)
  ) {
    const checked = field instanceof HTMLInputElement && field.checked
    fieldBaseline.set(field, { value: field.value, checked })
  }
}

/** One navigation step back; does nothing on the top-level mail list. */
function goBack(): void {
  if (section.value === 'settings') {
    // Leaving the settings unmounts any open form; never drop unsaved input.
    const fields = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      '.settings input, .settings textarea',
    )
    const states = [...fields].map((field) => {
      const base = fieldBaseline.get(field)
      const checked = field instanceof HTMLInputElement ? field.checked : undefined
      return {
        type: field.type,
        value: field.value,
        defaultValue: base ? base.value : field.value,
        checked,
        defaultChecked: base ? base.checked : checked,
      }
    })
    if (hasUnsavedInput(states)) return
    if (editAccountId.value) editAccountId.value = ''
    else section.value = 'mail'
    return
  }
  if (unifiedOpen.value) {
    unifiedOpen.value = false
    return
  }
  mailView.value?.goBack()
}

// beforeinstallprompt fires once, early: listen before anything else mounts.
if (import.meta.client) listenForInstallPrompt()

/** Banner "Anleitung": open the install guide in the settings. */
async function showInstallGuide(): Promise<void> {
  section.value = 'settings'
  await nextTick()
  document.getElementById('install')?.scrollIntoView({ behavior: 'smooth' })
}

// Logout empties the list, which clears the badge as well.
watch(accounts, (list) => updateAppBadge(unreadBadgeCount(list)))

async function loadAccounts(): Promise<void> {
  try {
    const res = await fetch('/api/accounts')
    offlineState.reachable = true
    if (res.status === 401) {
      await handleUnauthorized()
      return
    }
    if (res.ok) {
      const body = (await res.json()) as AccountListResponse
      await forgetRemovedAccounts(body.accounts)
      accounts.value = body.accounts
      void cachePut(ACCOUNTS_KEY, body.accounts, { pinned: true })
      const anySyncing = body.accounts.some((a) => a.syncing)
      if (syncStatusSupported.value === false) {
        syncStatus.value = syncStatusFromAccounts(body.accounts)
        schedulePoll(anySyncing)
      } else if (statusTimer !== undefined || statusLoading) {
        // The status poll is running and reloads the list when a sync ends.
      } else if (anySyncing || syncStatusSupported.value === null) {
        void loadSyncStatus()
      } else {
        // Nothing syncing: the account list has all there is to show.
        syncStatus.value = syncStatusFromAccounts(body.accounts)
      }
    }
  } catch {
    offlineState.reachable = false
    // Offline: keep the last known list (and counts), else the cached one.
    if (accounts.value.length === 0) {
      accounts.value = (await cacheGet<AccountSummary[]>(ACCOUNTS_KEY)) ?? []
    }
  }
}

/** Deleted accounts (here or on another device): drop their cached data. */
async function forgetRemovedAccounts(next: AccountSummary[]): Promise<void> {
  const previous =
    accounts.value.length > 0
      ? accounts.value
      : ((await cacheGet<AccountSummary[]>(ACCOUNTS_KEY)) ?? [])
  const ids = new Set(next.map((a) => a.id))
  for (const account of previous) {
    if (!ids.has(account.id)) await cacheDeleteAccount(account.id)
  }
}

/** Fast follow-up refresh while a triggered sync is still running. */
function schedulePoll(anySyncing: boolean): void {
  clearTimeout(pollTimer)
  const delay = syncPolicy.nextPollDelay(anySyncing)
  if (delay === null || document.visibilityState !== 'visible') return
  pollTimer = setTimeout(() => {
    if (view.value === 'app') void loadAccounts()
  }, delay)
}

function stopPolling(): void {
  syncPolicy.stop()
  clearTimeout(pollTimer)
  clearTimeout(statusTimer)
  statusTimer = undefined
}

/**
 * Sync state of all accounts (#119). Polls itself while a sync is active;
 * reloads the account list for every account whose sync just ended.
 */
async function loadSyncStatus(): Promise<void> {
  clearTimeout(statusTimer)
  statusTimer = undefined
  if (statusLoading || view.value !== 'app') return
  statusLoading = true
  const epoch = statusEpoch
  try {
    const res = await fetch('/api/sync/status')
    if (res.status === 401) {
      await handleUnauthorized()
      return
    }
    if (res.status === 404) {
      // Backend without the endpoint: fall back to `syncing` (4.5).
      syncStatusSupported.value = false
      syncStatus.value = syncStatusFromAccounts(accounts.value)
      schedulePoll(accounts.value.some((a) => a.syncing))
      return
    }
    if (!res.ok) return
    const next = ((await res.json()) as SyncStatusResponse).accounts
    syncStatusSupported.value = true
    if (epoch !== statusEpoch) {
      // Requested before a stop: ask again instead of showing the old state.
      statusTimer = setTimeout(() => void loadSyncStatus(), 0)
      return
    }
    const finished = finishedSyncs(syncStatus.value, next)
    syncStatus.value = next
    if (finished.length > 0) void loadAccounts()
    if (!onlyQueuedSyncs(next)) onlyQueuedSince = null
    else onlyQueuedSince ??= Date.now()
    const delay = nextSyncStatusPoll(next, onlyQueuedSince ? Date.now() - onlyQueuedSince : 0)
    if (delay !== null && document.visibilityState === 'visible') {
      statusTimer = setTimeout(() => void loadSyncStatus(), delay)
    }
  } catch {
    // Offline: keep the last state; the next foreground event asks again.
  } finally {
    statusLoading = false
  }
}

/**
 * "Stoppen" (#119) for one account or all: the state shows "wird
 * gestoppt" at once (the spinner stops), then the status is polled until
 * the running sync has ended.
 */
async function cancelSync(accountId: string | null): Promise<void> {
  statusEpoch++
  syncStatus.value = syncStatus.value.map((s) =>
    (accountId === null || s.accountId === accountId) && isSyncActive(s)
      ? { ...s, state: s.state === 'queued' ? 'idle' : 'cancelling' }
      : s,
  )
  const path = accountId ? `/api/accounts/${accountId}/sync/cancel` : '/api/sync/cancel'
  try {
    const res = await fetch(path, { method: 'POST' })
    if (res.status === 401) {
      await handleUnauthorized()
      return
    }
  } catch {
    // Offline: the status request below restores the real state later.
  }
  statusEpoch++
  await loadSyncStatus()
}

/**
 * Asks the server to sync all accounts now and refreshes the list. The
 * server skips accounts that are syncing, rate-limited or broken; the
 * request is only a hint, so errors (offline) are ignored.
 */
async function syncNow(force = false): Promise<void> {
  if (view.value !== 'app' || !syncPolicy.trigger(force)) return
  await fetch('/api/sync', { method: 'POST' }).catch(() => {})
  await loadAccounts()
}

/**
 * Refresh button / pull-to-refresh in MailView (4.8) already asked the
 * server: open the poll window and refresh, so the view reloads once the
 * sync finished. Same after adding or importing accounts: their first sync
 * is already queued, without the poll window the view would only notice
 * its end with the next regular account refresh (60 s).
 */
function onManualSync(): void {
  syncPolicy.trigger(true)
  // Show the new sync at once, even before the account list reports it.
  if (syncStatusSupported.value !== false) void loadSyncStatus()
  void loadAccounts()
}

/** Sync panel "Stoppen"/"Alle stoppen". */
function onCancelSync(accountId: string | null): void {
  void cancelSync(accountId)
}

/**
 * visibilitychange/focus/online: replay queued actions and sync when shown,
 * stop polling when hidden. Started offline: check the session first.
 */
function onForeground(): void {
  offlineState.online = navigator.onLine
  if (view.value !== 'app') return
  if (document.visibilityState !== 'visible') {
    stopPolling()
    return
  }
  if (navigator.onLine === false) return
  if (!sessionVerified) {
    void loadStatus()
    return
  }
  void replayQueue().then(() => syncNow())
}

function onOffline(): void {
  offlineState.online = false
}

/** The service worker forwards notification clicks (new mail): sync now. */
function onWorkerMessage(event: MessageEvent): void {
  const data = event.data as { type?: string } | null
  if (data?.type === 'SYNC_REQUEST') void syncNow(true)
}

/** Opens the edit form of an account in the settings (e.g. new credentials). */
function editAccount(id: string): void {
  editAccountId.value = id
  section.value = 'settings'
}

/** Unread counts and status of all accounts; quiet periodic refresh. */
function refreshAccounts(): void {
  if (view.value !== 'app' || document.visibilityState !== 'visible') return
  if (sessionVerified) void loadAccounts()
  else if (navigator.onLine !== false) void loadStatus()
}

function guessPlatform(): string {
  const ua = navigator.userAgent
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios_pwa'
  if (/Android/i.test(ua)) return 'android_pwa'
  return 'desktop'
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...options,
    headers: {
      // Only send a content-type when there is a body; Fastify rejects empty
      // JSON bodies otherwise (broke DELETE logout/revocation before).
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    },
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null
    throw new Error(body?.message ?? `Fehler ${res.status}`)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

async function loadStatus(): Promise<void> {
  let status: AuthStatus
  try {
    status = await api<AuthStatus>('/api/auth/status')
  } catch {
    // Server unreachable: start with the cached data of the last session.
    const session = await cacheGet<{ email: string }>(SESSION_KEY)
    if (session) {
      await startOffline(session.email)
      return
    }
    error.value = 'API nicht erreichbar'
    view.value = 'login'
    return
  }
  offlineState.reachable = true
  if (status.authenticated) {
    await enterApp(status.email ?? '')
    return
  }
  // No (longer a) session: nothing of a previous one may stay on the device.
  if (view.value === 'app') await handleUnauthorized()
  else await clearOffline()
  view.value = status.needsSetup ? 'setup' : 'login'
}

/** Confirmed session: (re)enable the offline store, replay, then sync. */
async function enterApp(userEmail: string): Promise<void> {
  const session = await cacheGet<{ email: string }>(SESSION_KEY)
  if (session && session.email !== userEmail) await clearOffline()
  enableOfflineData()
  sessionVerified = true
  void cachePut(SESSION_KEY, { email: userEmail }, { pinned: true })
  currentEmail.value = userEmail
  error.value = ''
  if (accounts.value.length === 0) {
    accounts.value = (await cacheGet<AccountSummary[]>(ACCOUNTS_KEY)) ?? []
  }
  view.value = 'app'
  await loadQueue()
  await replayQueue()
  await loadDevices()
  await loadSettings()
  await loadAccounts()
  void syncNow(true)
}

/** Offline start from the cache; the session is checked once online again. */
async function startOffline(userEmail: string): Promise<void> {
  // Actions taken offline must be stored (queue) - the cache belongs to
  // this session as far as the device knows.
  enableOfflineData()
  sessionVerified = false
  offlineState.reachable = false
  currentEmail.value = userEmail
  error.value = ''
  accounts.value = (await cacheGet<AccountSummary[]>(ACCOUNTS_KEY)) ?? []
  await loadQueue()
  view.value = 'app'
}

async function clearOffline(): Promise<void> {
  sessionVerified = false
  await clearOfflineData()
  resetOfflineState()
}

/** 401 from any request: session expired or this device was revoked. */
async function handleUnauthorized(): Promise<void> {
  if (view.value !== 'app') return
  stopPolling()
  const lost = pendingCount.value
  await clearOffline()
  devices.value = []
  accounts.value = []
  syncStatus.value = []
  currentEmail.value = ''
  view.value = 'login'
  info.value =
    'Die Sitzung ist abgelaufen. Bitte erneut anmelden.' +
    (lost === 1
      ? ' Eine ausstehende Aktion wurde verworfen.'
      : lost > 1
        ? ` ${lost} ausstehende Aktionen wurden verworfen.`
        : '')
}

async function submit(): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = ''
  info.value = ''
  const path = view.value === 'setup' ? '/api/auth/setup' : '/api/auth/login'
  try {
    const res = await api<{ email: string }>(path, {
      method: 'POST',
      body: JSON.stringify({
        email: email.value,
        password: password.value,
        deviceName: deviceName.value || undefined,
        platform: guessPlatform(),
        ...(view.value === 'setup' ? { setupCode: setupCode.value } : {}),
      }),
    })
    password.value = ''
    setupCode.value = ''
    info.value = ''
    await enterApp(res.email)
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Unbekannter Fehler'
  } finally {
    busy.value = false
  }
}

// Optional unified inbox (3.7): server-side setting, off by default. While
// it is on, the mail view offers "Alle Posteingänge" above the accounts.
const unifiedEnabled = ref(false)
const unifiedOpen = ref(false)
const unifiedBusy = ref(false)

async function loadSettings(): Promise<void> {
  try {
    const res = await api<UserSettings>('/api/settings')
    unifiedEnabled.value = res.unifiedInbox
  } catch {
    // Offline or failed: keep the current value (default off).
  }
  if (!unifiedEnabled.value) unifiedOpen.value = false
}

async function setUnifiedInbox(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  unifiedBusy.value = true
  error.value = ''
  try {
    const res = await api<UserSettings>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ unifiedInbox: input.checked }),
    })
    unifiedEnabled.value = res.unifiedInbox
  } catch (err) {
    error.value =
      err instanceof Error ? err.message : 'Einstellung konnte nicht gespeichert werden.'
  } finally {
    input.checked = unifiedEnabled.value
    // Saved immediately: the toggle never counts as unsaved input.
    fieldBaseline.set(input, { value: input.value, checked: input.checked })
    unifiedBusy.value = false
    if (!unifiedEnabled.value) unifiedOpen.value = false
  }
}

/** A message picked in the unified inbox opens in its own account's view. */
async function openUnifiedMessage(accountId: string, messageId: string): Promise<void> {
  unifiedOpen.value = false
  await nextTick()
  await mailView.value?.openFromUnified(accountId, messageId)
}

async function loadDevices(): Promise<void> {
  try {
    const res = await api<{ devices: DeviceInfo[] }>('/api/auth/devices')
    devices.value = res.devices
  } catch {
    devices.value = []
  }
}

async function revokeDevice(device: DeviceInfo): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    await api(`/api/auth/devices/${device.id}`, { method: 'DELETE' })
    info.value = `„${device.name}“ wurde abgemeldet.`
    await loadDevices()
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Unbekannter Fehler'
  } finally {
    busy.value = false
  }
}

async function logout(): Promise<void> {
  stopPolling()
  await api('/api/auth/session', { method: 'DELETE' }).catch(() => {})
  await clearOffline()
  email.value = ''
  password.value = ''
  devices.value = []
  accounts.value = []
  syncStatus.value = []
  currentEmail.value = ''
  info.value = ''
  await loadStatus()
}

onMounted(() => {
  onUnauthorized(() => void handleUnauthorized())
  void loadStatus()
  accountTimer = setInterval(refreshAccounts, ACCOUNT_REFRESH_MS)
  window.addEventListener('focus', onForeground)
  window.addEventListener('online', onForeground)
  window.addEventListener('offline', onOffline)
  document.addEventListener('visibilitychange', onForeground)
  window.addEventListener('touchstart', onSwipeStart, { passive: true })
  window.addEventListener('touchmove', onSwipeMove, { passive: true })
  window.addEventListener('touchend', onSwipeEnd, { passive: true })
  window.addEventListener('touchcancel', onSwipeCancel, { passive: true })
  document.addEventListener('focusin', recordFieldBaseline, true)
  document.addEventListener('pointerdown', recordFieldBaseline, true)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', onWorkerMessage)
  }
})

onBeforeUnmount(() => {
  clearInterval(accountTimer)
  stopPolling()
  window.removeEventListener('focus', onForeground)
  window.removeEventListener('online', onForeground)
  window.removeEventListener('offline', onOffline)
  document.removeEventListener('visibilitychange', onForeground)
  window.removeEventListener('touchstart', onSwipeStart)
  window.removeEventListener('touchmove', onSwipeMove)
  window.removeEventListener('touchend', onSwipeEnd)
  window.removeEventListener('touchcancel', onSwipeCancel)
  document.removeEventListener('focusin', recordFieldBaseline, true)
  document.removeEventListener('pointerdown', recordFieldBaseline, true)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.removeEventListener('message', onWorkerMessage)
  }
})
</script>

<template>
  <main class="shell" :class="{ wide: view === 'app' && section === 'mail' }">
    <h1>fastmail-alternative</h1>

    <div v-if="view === 'loading'" class="card">Wird geladen &hellip;</div>

    <!-- First start: create the single user -->
    <form v-else-if="view === 'setup'" class="card form" @submit.prevent="submit">
      <h2>Einrichtung</h2>
      <p class="hint">Ersten Benutzer anlegen (Single-User-Instanz, ADR-0004).</p>
      <label
        >Setup-Code<input
          v-model="setupCode"
          type="text"
          autocomplete="off"
          autocapitalize="characters"
          spellcheck="false"
          required
      /></label>
      <p class="hint">
        Steht im Log der API: <code>docker compose logs api</code> (oder
        <code>SETUP_TOKEN</code> aus <code>.env</code>).
      </p>
      <label>E-Mail<input v-model="email" type="email" autocomplete="username" required /></label>
      <label
        >Passwort (min. 10 Zeichen)<input
          v-model="password"
          type="password"
          autocomplete="new-password"
          minlength="10"
          required
      /></label>
      <label
        >Gerätename (optional)<input v-model="deviceName" type="text" placeholder="z. B. MacBook"
      /></label>
      <button type="submit" :disabled="busy">Konto erstellen</button>
    </form>

    <!-- Login -->
    <form v-else-if="view === 'login'" class="card form" @submit.prevent="submit">
      <h2>Anmeldung</h2>
      <label>E-Mail<input v-model="email" type="email" autocomplete="username" required /></label>
      <label
        >Passwort<input v-model="password" type="password" autocomplete="current-password" required
      /></label>
      <label
        >Gerätename (optional)<input v-model="deviceName" type="text" placeholder="z. B. iPhone"
      /></label>
      <button type="submit" :disabled="busy">Anmelden</button>
    </form>

    <!-- Authenticated app: mail view and settings -->
    <template v-else>
      <nav class="topbar">
        <span class="tabs">
          <button
            type="button"
            class="tab"
            :class="{ active: section === 'mail' }"
            @click="section = 'mail'"
          >
            E-Mail
          </button>
          <button
            type="button"
            class="tab"
            :class="{ active: section === 'settings' }"
            @click="section = 'settings'"
          >
            Einstellungen
          </button>
        </span>
        <span class="status">
          <span
            v-if="isOffline"
            class="tag offline"
            role="status"
            title="Keine Verbindung zum Server – angezeigt werden gespeicherte Daten"
            >Offline</span
          >
          <span v-if="pendingCount > 0" class="tag pending" role="status">{{ pendingText }}</span>
          <span class="user">{{ currentEmail }}</span>
        </span>
      </nav>
      <ul v-if="offlineState.notices.length" class="notices">
        <li v-for="(notice, index) in offlineState.notices" :key="index" class="message info">
          <span>{{ notice }}</span>
          <button type="button" class="link" @click="dismissNotice(index)">OK</button>
        </li>
      </ul>

      <InstallBanner @guide="showInstallGuide" />

      <!-- Swipe back (4.9): arrow at the left edge follows the finger -->
      <div
        v-if="swipeDistance > 0"
        class="swipe-indicator"
        :class="{ armed: swipeArmed }"
        :style="{ transform: `translateX(${swipeDistance / 2}px)` }"
        aria-hidden="true"
      >
        &larr;
      </div>

      <template v-if="section === 'mail'">
        <UnifiedInbox
          v-if="accounts.length > 0 && unifiedEnabled && unifiedOpen"
          :accounts="accounts"
          @open="openUnifiedMessage"
          @back="unifiedOpen = false"
        />
        <MailView
          v-if="accounts.length > 0"
          v-show="!(unifiedEnabled && unifiedOpen)"
          ref="mailView"
          :accounts="accounts"
          :unified-inbox="unifiedEnabled"
          :sync-status="syncStatus"
          :sync-cancel-supported="syncStatusSupported === true"
          @open-unified="unifiedOpen = true"
          @edit-account="editAccount"
          @sync-requested="onManualSync"
          @cancel-sync="onCancelSync"
        />
        <div v-else class="card">
          <p>Noch kein E-Mail-Konto verbunden.</p>
          <button type="button" @click="section = 'settings'">Konto hinzufügen</button>
        </div>
      </template>

      <div v-else class="settings">
        <div class="card">
          <p>
            Angemeldet als <strong>{{ currentEmail }}</strong>
          </p>
          <button type="button" :disabled="busy" @click="logout">Abmelden</button>
        </div>

        <AccountList
          v-model:edit="editAccountId"
          :accounts="accounts"
          @deleted="loadAccounts"
          @changed="loadAccounts"
        />
        <AccountForm @created="onManualSync" />
        <ConfigTransfer @imported="onManualSync" />

        <div class="card">
          <h2>Geräte</h2>
          <p class="hint">Ein Gerät abzumelden beendet alle zugehörigen Sitzungen.</p>
          <ul class="devices">
            <li v-for="device in devices" :key="device.id">
              <span>
                <strong>{{ device.name }}</strong>
                <span class="tag">{{ device.platform }}</span>
                <span v-if="device.isCurrent" class="tag current">dieses Gerät</span>
              </span>
              <button
                v-if="!device.isCurrent"
                type="button"
                :disabled="busy"
                @click="revokeDevice(device)"
              >
                Abmelden
              </button>
            </li>
          </ul>
        </div>

        <div class="card">
          <h2>Posteingang</h2>
          <label class="checkbox">
            <input
              type="checkbox"
              :checked="unifiedEnabled"
              :disabled="unifiedBusy"
              @change="setUnifiedInbox"
            />
            Gemeinsamer Posteingang (alle Konten)
          </label>
          <p class="hint">
            Standardmäßig bleiben die Konten getrennt. Eingeschaltet zeigt „Alle Posteingänge“ die
            Posteingänge aller Konten in einer Liste, jede Nachricht mit ihrem Konto; geantwortet
            wird immer aus dem Konto der Nachricht. Nur online verfügbar.
          </p>
        </div>

        <PasswordChange @changed="loadDevices" />

        <InstallGuide />
        <PushSettings />
      </div>
    </template>

    <p v-if="error" class="message error">{{ error }}</p>
    <p v-else-if="info" class="message info">{{ info }}</p>
    <UpdatePrompt />
  </main>
</template>

<style scoped>
.swipe-indicator {
  position: fixed;
  top: 50%;
  left: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 2.5rem;
  height: 2.5rem;
  margin-top: -1.25rem;
  border-radius: 50%;
  background: #e4e9ee;
  color: #52606d;
  font-size: 1.2rem;
  opacity: 0.7;
  pointer-events: none;
  transition:
    background-color 0.15s,
    opacity 0.15s;
}

.swipe-indicator.armed {
  background: #1273de;
  color: #fff;
  opacity: 1;
}

@media (prefers-reduced-motion: reduce) {
  .swipe-indicator {
    transform: none !important;
    transition: none;
  }
}

.shell {
  max-width: 28rem;
  margin: 3rem auto;
  padding: 0 1rem;
  font-family: system-ui, sans-serif;
  color: #1f2933;
}

.shell.wide {
  max-width: 90rem;
  margin-top: 1rem;
}

.shell.wide h1 {
  display: none;
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 1rem;
}

.tabs {
  display: flex;
  gap: 0.25rem;
}

button.tab {
  padding: 0.4rem 0.9rem;
  white-space: nowrap;
  background: transparent;
  color: #3e4c59;
}

button.tab.active {
  background: #e4e9ee;
  color: #1f2933;
  font-weight: 600;
}

.status {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  min-width: 0;
}

.tag.offline {
  background: #fde8e8;
  color: #9b1c1c;
}

.tag.pending {
  background: #fff3c4;
  color: #8d2b0b;
}

.status .tag {
  margin-left: 0;
  white-space: nowrap;
}

.notices {
  list-style: none;
  margin: 0 0 1rem;
  padding: 0;
}

.notices li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.4rem;
}

button.link {
  padding: 0.2rem 0.5rem;
  background: transparent;
  color: #046c4e;
  font-weight: 600;
}

.user {
  min-width: 0;
  overflow: hidden;
  font-size: 0.85rem;
  color: #52606d;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card {
  display: block;
  padding: 1rem 1.25rem;
  margin-bottom: 1rem;
  border: 1px solid #d5dde5;
  border-radius: 0.5rem;
  background: #f7f9fb;
}

h2 {
  margin: 0 0 0.25rem;
  font-size: 1.1rem;
}

.checkbox {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.hint {
  margin: 0 0 0.75rem;
  font-size: 0.85rem;
  color: #52606d;
}

.form label {
  display: block;
  margin-bottom: 0.75rem;
  font-size: 0.9rem;
}

.form input {
  display: block;
  width: 100%;
  margin-top: 0.25rem;
  padding: 0.5rem;
  border: 1px solid #b8c2cc;
  border-radius: 0.375rem;
  box-sizing: border-box;
  font: inherit;
}

button {
  padding: 0.5rem 1rem;
  border: none;
  border-radius: 0.375rem;
  background: #1273de;
  color: #fff;
  font: inherit;
  cursor: pointer;
}

button:disabled {
  opacity: 0.6;
  cursor: wait;
}

.devices {
  list-style: none;
  margin: 0;
  padding: 0;
}

.devices li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.5rem 0;
  border-bottom: 1px solid #e4e9ee;
}

.devices li:last-child {
  border-bottom: none;
}

.tag {
  display: inline-block;
  margin-left: 0.4rem;
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  background: #e4e9ee;
  font-size: 0.75rem;
  color: #3e4c59;
}

.tag.current {
  background: #d9f2e4;
  color: #147d46;
}

.message {
  padding: 0.75rem 1rem;
  border-radius: 0.375rem;
  font-size: 0.9rem;
}

.message.error {
  background: #fde8e8;
  color: #9b1c1c;
}

.message.info {
  background: #def7ec;
  color: #046c4e;
}
</style>
