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
// endpoint (404, e.g. an older server) keeps the 4.5 behavior: the state comes
// from `syncing`, the account list is polled, there is no stop button.
// App frame (#120): full-width layout with the header (search, help,
// profile menu with settings and logout) and the account bar on the left
// (AccountRail): one icon per account, switching accounts is the primary
// navigation. Small screens get the accounts in a side menu. The bar's
// width (names shown or not) is remembered per device; the account order
// is saved as the accounts' sort order.
import {
  ForegroundSyncPolicy,
  SwipeBack,
  sortOrderUpdates,
  UNDO_SEND_CHOICES,
  parseUndoSendSeconds,
  DENSITY_CHOICES,
  THEME_CHOICES,
  parseDensity,
  parseTheme,
  finishedSyncs,
  hasUnsavedInput,
  isSyncActive,
  nextSyncStatusPoll,
  onlyQueuedSyncs,
  syncStatusFromAccounts,
  unreadBadgeCount,
  oauthResultFromQuery,
  withoutOAuthResult,
} from '@fma/shared'
import type {
  AccountListResponse,
  AccountSummary,
  AccountSyncStatus,
  OAuthResult,
  ReadingPane,
  SyncStatusResponse,
  ThemeLayout,
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
  addNotice,
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
import { setShortcutsEnabled, shortcutsEnabled } from '~/utils/shortcuts-setting'
import { densityChoice, setAppearance, themeChoice } from '~/utils/appearance'
import { setUndoSendSeconds, undoSendSeconds } from '~/utils/undo-send'

interface AuthStatus {
  needsSetup: boolean
  authenticated: boolean
  email?: string
  /** Setup pending and the MASTER_KEY was generated on the first start (#164). */
  masterKeyGenerated?: boolean
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
// Sync status (#119); supported: null = not asked yet, false = 404 (older server).
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
  openFromUnified: (accountId: string, messageId: string, folderId?: string) => Promise<void>
  switchAccount: (id: string) => boolean
  searchFor: (query: string) => void
  currentFolder: () => string
  setReadingPane: (pane: ReadingPane) => void
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
  if (globalSearchOpen.value) {
    globalSearchOpen.value = false
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

// Sign-in with Google/Microsoft (#36): the server sends the browser back to
// /?oauth=...; the result is shown once the session is confirmed.
let pendingOAuth: OAuthResult | null = null

function takeOAuthResult(): void {
  pendingOAuth = oauthResultFromQuery(location.search)
  if (!pendingOAuth) return
  history.replaceState(
    history.state,
    '',
    `${location.pathname}${withoutOAuthResult(location.search)}${location.hash}`,
  )
}

function showOAuthResult(): void {
  const result = pendingOAuth
  pendingOAuth = null
  if (!result) return
  addNotice(result.message)
  if (result.ok && result.accountId && accounts.value.some((a) => a.id === result.accountId)) {
    void selectAccount(result.accountId)
  } else if (!result.ok) {
    section.value = 'settings'
  }
}

/** Opens the edit form of an account in the settings (e.g. new credentials). */
function editAccount(id: string): void {
  editAccountId.value = id
  section.value = 'settings'
}

// --- App frame (#120) ---
const RAIL_EXPANDED_KEY = 'fma.frame.railExpanded'
const activeAccountId = ref('')
// Live INBOX unread count of the active account (from its folder list).
const activeInboxUnread = ref<number | null>(null)
const menuOpen = ref(false)

// Side menu: focus its first entry when it opens.
watch(menuOpen, async (open) => {
  if (!open) return
  await nextTick()
  document.querySelector<HTMLElement>('#side-menu button')?.focus()
})
const railExpanded = ref(readRailExpanded())

function readRailExpanded(): boolean {
  try {
    return import.meta.client && localStorage.getItem(RAIL_EXPANDED_KEY) === '1'
  } catch {
    return false
  }
}

function setRailExpanded(expanded: boolean): void {
  railExpanded.value = expanded
  try {
    localStorage.setItem(RAIL_EXPANDED_KEY, expanded ? '1' : '0')
  } catch {
    // Private mode: only for this session.
  }
}

/** Accounts for the bar; the active one shows the live INBOX count. */
const railAccounts = computed(() =>
  accounts.value.map((a) =>
    a.id === activeAccountId.value && activeInboxUnread.value !== null
      ? { ...a, unreadCount: activeInboxUnread.value }
      : a,
  ),
)

function onActiveAccount(id: string, inboxUnread: number | null): void {
  activeAccountId.value = id
  activeInboxUnread.value = inboxUnread
}

/** Account bar / side menu: show the mail of this account. */
async function selectAccount(id: string): Promise<void> {
  menuOpen.value = false
  section.value = 'mail'
  unifiedOpen.value = false
  globalSearchOpen.value = false
  await nextTick()
  mailView.value?.switchAccount(id)
}

function openUnifiedInbox(): void {
  menuOpen.value = false
  section.value = 'mail'
  globalSearchOpen.value = false
  unifiedOpen.value = true
}

async function openSettings(): Promise<void> {
  menuOpen.value = false
  section.value = 'settings'
  await nextTick()
  document.querySelector<HTMLElement>('.settings h1')?.focus()
}

const appHeader = ref<{ openHelp: () => void } | null>(null)

/** Layout options of an activated theme (#126), taken over once for this device. */
function applyThemeLayout(layout: ThemeLayout): void {
  if (layout.density) setAppearance(themeChoice.value, layout.density)
  if (layout.accountRail) setRailExpanded(layout.accountRail === 'list')
  if (layout.readingPane) mailView.value?.setReadingPane(layout.readingPane)
}

/** Settings: theme and density (#112, per device). */
function onAppearanceChange(event: Event): void {
  const input = event.target as HTMLInputElement
  const form = input.closest('.card')
  const value = (name: string) =>
    form?.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value
  setAppearance(parseTheme(value('theme')), parseDensity(value('density')))
  // Saved at once: never unsaved input for the swipe back.
  form?.querySelectorAll<HTMLInputElement>('input').forEach((field) => {
    fieldBaseline.set(field, { value: field.value, checked: field.checked })
  })
}

/** Settings: undo-send window (#116, per device). */
function onUndoSendChange(event: Event): void {
  const select = event.target as HTMLSelectElement
  setUndoSendSeconds(parseUndoSendSeconds(select.value))
}

/** Settings: keyboard shortcuts on/off (#115, per device). */
function onShortcutsToggle(event: Event): void {
  const input = event.target as HTMLInputElement
  setShortcutsEnabled(input.checked)
  // Saved at once: the toggle never counts as unsaved input (swipe back).
  fieldBaseline.set(input, { value: input.value, checked: input.checked })
}

/** First steps: a section of the settings (push, install guide). */
async function openSettingsSection(id: 'push' | 'install'): Promise<void> {
  menuOpen.value = false
  section.value = 'settings'
  await nextTick()
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' })
}

/** "+" in the account bar: the form in the settings. */
async function addAccount(): Promise<void> {
  menuOpen.value = false
  section.value = 'settings'
  await nextTick()
  const form = document.getElementById('add-account')
  form?.scrollIntoView({ behavior: 'smooth' })
  form?.querySelector<HTMLInputElement>('input')?.focus()
}

// Global search (#121): the header search looks in all accounts; the hits
// replace the mail view until "Suche beenden" (or back / an account pick).
const globalSearchOpen = ref(false)
const globalSearchText = ref('')
const globalSearchFolder = ref('')
const globalSearch = ref<{ search: () => Promise<void> } | null>(null)

async function onHeaderSearch(query: string): Promise<void> {
  section.value = 'mail'
  unifiedOpen.value = false
  globalSearchFolder.value = mailView.value?.currentFolder() ?? ''
  const again = globalSearchOpen.value && globalSearchText.value === query
  globalSearchText.value = query
  globalSearchOpen.value = true
  // The same text again: search again (the component reacts to changes only).
  if (again) await globalSearch.value?.search()
}

/** A search hit opens in its own account's view, in the folder it was found in. */
async function openSearchHit(
  accountId: string,
  folderId: string,
  messageId: string,
): Promise<void> {
  globalSearchOpen.value = false
  await nextTick()
  await mailView.value?.openFromUnified(accountId, messageId, folderId)
}

/** Drag and drop in the account bar: show at once, then save the sort order. */
async function reorderAccounts(ids: string[]): Promise<void> {
  const previous = accounts.value
  const updates = sortOrderUpdates(ids, previous)
  const byId = new Map(previous.map((a) => [a.id, a]))
  accounts.value = ids
    .map((id, index) => {
      const account = byId.get(id)
      return account ? { ...account, sortOrder: index } : undefined
    })
    .filter((a): a is AccountSummary => a !== undefined)
  try {
    for (const { id, sortOrder } of updates) {
      await api(`/api/accounts/${id}`, { method: 'PATCH', body: JSON.stringify({ sortOrder }) })
    }
  } catch (err) {
    error.value =
      err instanceof Error ? err.message : 'Reihenfolge konnte nicht gespeichert werden.'
    accounts.value = previous
  }
  void loadAccounts()
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
      // Only send a content-type when there is a body; some servers reject
      // empty JSON bodies otherwise (broke DELETE logout/revocation before).
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

const masterKeyGenerated = ref(false)

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
  masterKeyGenerated.value = status.masterKeyGenerated === true
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
  showOAuthResult()
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
  takeOAuthResult()
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
  <!-- App frame (#120): header across the full width, account bar on the left -->
  <div v-if="view === 'app'" class="app-frame" :class="{ 'menu-open': menuOpen }">
    <AppHeader
      ref="appHeader"
      :email="currentEmail"
      :search-placeholder="
        accounts.length === 0
          ? 'Kein Konto verbunden'
          : isOffline
            ? 'Gespeicherte Nachrichten durchsuchen …'
            : 'In allen Konten suchen …'
      "
      :search-disabled="accounts.length === 0"
      :menu-open="menuOpen"
      @search="onHeaderSearch"
      @toggle-menu="menuOpen = !menuOpen"
      @settings="openSettings"
      @logout="logout"
    >
      <template #status>
        <span
          v-if="isOffline"
          class="tag offline"
          role="status"
          title="Keine Verbindung zum Server – angezeigt werden gespeicherte Daten"
          >Offline</span
        >
        <span v-if="pendingCount > 0" class="tag pending" role="status">{{ pendingText }}</span>
      </template>
    </AppHeader>

    <div class="app-body">
      <AccountRail
        class="desktop-rail"
        mode="rail"
        :accounts="railAccounts"
        :active-account-id="section === 'mail' ? activeAccountId : ''"
        :statuses="syncStatus"
        :unified-inbox="unifiedEnabled"
        :unified-active="section === 'mail' && unifiedEnabled && unifiedOpen"
        :expanded="railExpanded"
        @update:expanded="setRailExpanded"
        @select="selectAccount"
        @open-unified="openUnifiedInbox"
        @add="addAccount"
        @reorder="reorderAccounts"
      />

      <main class="app-main">
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
            v-if="accounts.length > 0 && unifiedEnabled && unifiedOpen && !globalSearchOpen"
            :accounts="accounts"
            @open="openUnifiedMessage"
            @back="unifiedOpen = false"
          />
          <GlobalSearch
            v-if="accounts.length > 0 && globalSearchOpen"
            ref="globalSearch"
            :accounts="accounts"
            :text="globalSearchText"
            :active-account-id="activeAccountId"
            :active-folder-id="globalSearchFolder"
            @open="openSearchHit"
            @close="globalSearchOpen = false"
          />
          <MailView
            v-if="accounts.length > 0"
            v-show="!(unifiedEnabled && unifiedOpen) && !globalSearchOpen"
            ref="mailView"
            :shortcuts-active="!(unifiedEnabled && unifiedOpen) && !globalSearchOpen"
            :accounts="accounts"
            :sync-status="syncStatus"
            :sync-cancel-supported="syncStatusSupported === true"
            @active-account="onActiveAccount"
            @edit-account="editAccount"
            @sync-requested="onManualSync"
            @cancel-sync="onCancelSync"
          />
          <div v-else class="empty-state">
            <p>Noch kein E-Mail-Konto verbunden.</p>
            <GettingStarted
              :has-accounts="false"
              @add-account="addAccount"
              @open="openSettingsSection"
              @shortcuts="appHeader?.openHelp()"
            />
          </div>
        </template>

        <div v-else class="settings">
          <div class="settings-head">
            <h1 tabindex="-1">Einstellungen</h1>
            <button type="button" class="link" @click="section = 'mail'">Zurück zur Post</button>
          </div>
          <p class="hint">
            Angemeldet als <strong>{{ currentEmail }}</strong>
          </p>
          <GettingStarted
            :has-accounts="accounts.length > 0"
            @add-account="addAccount"
            @open="openSettingsSection"
            @shortcuts="appHeader?.openHelp()"
          />

          <AccountList
            v-model:edit="editAccountId"
            :accounts="accounts"
            @deleted="loadAccounts"
            @changed="loadAccounts"
          />
          <AccountForm id="add-account" @created="onManualSync" />
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
              Standardmäßig bleiben die Konten getrennt. Eingeschaltet zeigt „Alle Konten“ in der
              Kontoleiste die Posteingänge aller Konten in einer Liste, jede Nachricht mit ihrem
              Konto; geantwortet wird immer aus dem Konto der Nachricht. Nur online verfügbar.
            </p>
          </div>

          <div class="card">
            <h2>Darstellung</h2>
            <fieldset class="choices">
              <legend>Farbschema</legend>
              <label v-for="choice in THEME_CHOICES" :key="choice.value" class="checkbox">
                <input
                  type="radio"
                  name="theme"
                  :value="choice.value"
                  :checked="themeChoice === choice.value"
                  @change="onAppearanceChange"
                />
                {{ choice.label }}
              </label>
            </fieldset>
            <fieldset class="choices">
              <legend>Dichte der Nachrichtenliste</legend>
              <label v-for="choice in DENSITY_CHOICES" :key="choice.value" class="checkbox">
                <input
                  type="radio"
                  name="density"
                  :value="choice.value"
                  :checked="densityChoice === choice.value"
                  @change="onAppearanceChange"
                />
                {{ choice.label }}
              </label>
            </fieldset>
            <p class="hint">
              Gilt für dieses Gerät. „Kompakt“ zeigt mehr Nachrichten und blendet die Vorschauzeile
              aus.
            </p>
            <ThemeSettings @layout="applyThemeLayout" />
          </div>

          <div class="card">
            <h2>Verfassen</h2>
            <label class="field-inline"
              >Senden rückgängig machen
              <select :value="undoSendSeconds" @change="onUndoSendChange">
                <option v-for="seconds in UNDO_SEND_CHOICES" :key="seconds" :value="seconds">
                  {{ seconds === 0 ? 'Aus' : `${seconds} Sekunden` }}
                </option>
              </select>
            </label>
            <p class="hint">
              So lange wartet die App nach „Senden“, bevor die Nachricht an den Server geht; in
              dieser Zeit holt „Rückgängig“ sie zurück in den Editor. Gilt für dieses Gerät.
            </p>
          </div>

          <div class="card">
            <h2>Tastenkürzel</h2>
            <label class="checkbox">
              <input type="checkbox" :checked="shortcutsEnabled" @change="onShortcutsToggle" />
              Tastenkürzel verwenden (j/k, r, e, # …)
            </label>
            <p class="hint">
              Gilt für dieses Gerät. Die Übersicht öffnet <kbd>?</kbd> oder das Hilfe-Symbol oben
              rechts; in Eingabefeldern sind Kürzel immer aus.
            </p>
          </div>

          <PasswordChange @changed="loadDevices" />

          <InstallGuide />
          <PushSettings />
        </div>

        <p v-if="error" class="message error">{{ error }}</p>
        <p v-else-if="info" class="message info">{{ info }}</p>
      </main>
    </div>

    <!-- Small screens: side menu with the accounts -->
    <div v-if="menuOpen" class="side-menu-backdrop" @click.self="menuOpen = false">
      <div
        id="side-menu"
        class="side-menu"
        role="dialog"
        aria-label="Konten"
        @keydown.esc="menuOpen = false"
      >
        <AccountRail
          mode="list"
          :accounts="railAccounts"
          :active-account-id="section === 'mail' ? activeAccountId : ''"
          :statuses="syncStatus"
          :unified-inbox="unifiedEnabled"
          :unified-active="section === 'mail' && unifiedEnabled && unifiedOpen"
          @select="selectAccount"
          @open-unified="openUnifiedInbox"
          @add="addAccount"
          @reorder="reorderAccounts"
        />
      </div>
    </div>
    <UpdatePrompt />
  </div>

  <main v-else class="shell">
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
        Steht im Log der API: <code>docker compose logs php</code> (oder
        <code>SETUP_TOKEN</code> aus <code>.env</code>).
      </p>
      <p v-if="masterKeyGenerated" class="warning" role="note" data-testid="master-key-warning">
        Der Master-Key wurde beim ersten Start automatisch erzeugt. Bitte jetzt getrennt von den
        Datenbank-Backups sichern: <code>docker compose exec php php bin/secrets.php export</code>.
        Ohne ihn sind alle Mails und Zugangsdaten verloren.
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
  background: var(--color-base-300);
  color: var(--fma-muted);
  font-size: 1.2rem;
  opacity: 0.7;
  pointer-events: none;
  transition:
    background-color 0.15s,
    opacity 0.15s;
}

.swipe-indicator.armed {
  background: var(--color-primary);
  color: var(--color-primary-content);
  opacity: 1;
}

@media (prefers-reduced-motion: reduce) {
  .swipe-indicator {
    transform: none !important;
    transition: none;
  }
}

.app-frame {
  display: flex;
  flex-direction: column;
  height: 100vh;
  height: 100dvh;
  background: var(--color-base-100);
  color: var(--color-base-content);
}

.app-body {
  display: flex;
  flex: 1;
  min-height: 0;
}

.app-main {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  overflow-y: auto;
}

/* The mail view fills the remaining height; it scrolls its columns itself. */
.app-main > :deep(.mail) {
  flex: 1;
}

.app-main > .notices,
.app-main > .message,
.app-main > .empty-state {
  margin: var(--fma-space-3) var(--fma-space-4);
}

.settings {
  width: 100%;
  max-width: 48rem;
  margin: 0 auto;
  padding: var(--fma-space-4);
}

.settings-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--fma-space-4);
}

.settings-head h1 {
  margin: 0 0 var(--fma-space-1);
}

.settings-head h1:focus {
  outline: none;
}

.field-inline {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--fma-space-2);
  margin-bottom: var(--fma-space-2);
}

.field-inline select {
  padding: 0.35rem;
  border: 1px solid var(--fma-border-strong);
  border-radius: var(--fma-radius);
  font: inherit;
}

.choices {
  display: flex;
  flex-wrap: wrap;
  gap: var(--fma-space-1) var(--fma-space-4);
  margin: 0 0 var(--fma-space-2);
  padding: 0;
  border: none;
}

.choices legend {
  width: 100%;
  margin-bottom: var(--fma-space-1);
  font-size: 0.9rem;
  font-weight: 600;
}

.settings-head .link {
  color: var(--color-primary);
}

.tag.offline,
.tag.pending {
  white-space: nowrap;
}

.side-menu-backdrop {
  position: fixed;
  inset: 0;
  z-index: 55;
  background: rgb(0 0 0 / 35%);
}

.side-menu {
  width: min(20rem, 85vw);
  height: 100%;
  padding: var(--fma-space-3);
  overflow-y: auto;
  background: var(--color-base-100);
  box-shadow: var(--fma-shadow);
}

/* Small screens: the page scrolls (pull-to-refresh and swipe-back rely on
   the window scroll position), the header stays on top. */
@media (max-width: 760px) {
  .app-frame {
    height: auto;
    min-height: 100dvh;
  }

  .app-frame > :deep(.app-header) {
    position: sticky;
    top: 0;
    z-index: 20;
  }

  .desktop-rail {
    display: none;
  }

  .app-main {
    padding-top: var(--fma-space-2);
    overflow: visible;
  }
}

.shell {
  max-width: 28rem;
  margin: 3rem auto;
  padding: 0 var(--fma-space-4);
  font-family: system-ui, sans-serif;
  color: var(--color-base-content);
}

.tag.offline {
  background: var(--fma-error-soft);
  color: var(--color-error);
}

.tag.pending {
  background: var(--fma-warning-soft);
  color: var(--fma-warning-text);
}

.notices {
  list-style: none;
  margin: 0 0 var(--fma-space-4);
  padding: 0;
}

.notices li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--fma-space-2);
  margin-bottom: 0.4rem;
}

button.link {
  padding: 0.2rem var(--fma-space-2);
  background: transparent;
  color: var(--color-success);
  font-weight: 600;
}

.card {
  display: block;
  padding: var(--fma-space-4) 1.25rem;
  margin-bottom: var(--fma-space-4);
  border: 1px solid var(--fma-border);
  border-radius: var(--fma-radius-box);
  background: var(--color-base-200);
}

h2 {
  margin: 0 0 var(--fma-space-1);
  font-size: var(--fma-text-lg);
}

.checkbox {
  display: flex;
  align-items: center;
  gap: var(--fma-space-2);
}

.hint {
  margin: 0 0 var(--fma-space-3);
  font-size: var(--fma-text-sm);
  color: var(--fma-muted);
}

.warning {
  margin: 0 0 var(--fma-space-3);
  padding: var(--fma-space-2) var(--fma-space-3);
  border-left: 3px solid var(--color-warning);
  border-radius: 0.25rem;
  background: var(--fma-warning-soft);
  font-size: var(--fma-text-sm);
}

.form label {
  display: block;
  margin-bottom: var(--fma-space-3);
  font-size: 0.9rem;
}

.form input {
  display: block;
  width: 100%;
  margin-top: var(--fma-space-1);
  padding: var(--fma-space-2);
  border: 1px solid var(--fma-border-strong);
  border-radius: var(--fma-radius);
  box-sizing: border-box;
  font: inherit;
}

button {
  padding: var(--fma-space-2) var(--fma-space-4);
  border: none;
  border-radius: var(--fma-radius);
  background: var(--color-primary);
  color: var(--color-primary-content);
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
  gap: var(--fma-space-2);
  padding: var(--fma-space-2) 0;
  border-bottom: 1px solid var(--color-base-300);
}

.devices li:last-child {
  border-bottom: none;
}

.tag {
  display: inline-block;
  margin-left: 0.4rem;
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  background: var(--color-base-300);
  font-size: var(--fma-text-xs);
  color: var(--fma-muted);
}

.tag.current {
  background: var(--fma-success-soft);
  color: var(--color-success);
}

.message {
  padding: var(--fma-space-3) var(--fma-space-4);
  border-radius: var(--fma-radius);
  font-size: 0.9rem;
}

.message.error {
  background: var(--fma-error-soft);
  color: var(--color-error);
}

.message.info {
  background: var(--fma-success-soft);
  color: var(--color-success);
}
</style>
