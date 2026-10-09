<script setup lang="ts">
// Inbox and folder view (roadmap 2.3): account picker, folder tree with
// unread counts, paginated message list and a plain-text detail pane.
// Basic actions (2.4): opening a message marks it as read; read/unread,
// flag, archive, delete and move are applied optimistically to the list and
// counts and rolled back if the API refuses them (the server writes them
// back to IMAP in the background). Bodies (2.9) are rendered by MessageBody:
// sanitized HTML in a sandboxed iframe, plain text as fallback.
// Compose (2.6): new message, reply, reply all and forward open the
// ComposeForm (prefilled via createDraft from @fma/shared); submitted
// messages show up in the OutboxPanel until they are sent.
// Threading (2.5): the list stays a message list (no conversation grouping)
// with a count badge; the detail pane shows the whole conversation across
// folders (e.g. own replies in Sent), older messages collapsed, the newest
// and the opened one expanded. Actions and replies apply to the opened one.
// Account switch (3.2): accounts stay separate; the sidebar lists them with
// their INBOX unread count (select on mobile), keys 1-9 / Ctrl+1-9 switch.
// Switching closes message, thread and compose of the previous account,
// aborts its in-flight requests and drops late responses (RequestScope from
// @fma/shared), so the view never mixes data of two accounts.
// Account health (3.4): broken accounts get a badge in the switcher and a
// banner with a German explanation and a link to the account settings.
// Sync on start/focus (4.5): when the account list shows that the active
// account has new data (sync finished, unread count changed), folders and
// the first list page are reloaded in place - loaded pages, scroll position,
// selection and the open message stay (mergeFirstPage from @fma/shared).
// Offline-first (4.6): folders, the first list pages (up to
// CACHED_LIST_MESSAGES), opened messages and threads and the identities are
// read from the encrypted IndexedDB cache first and then refreshed from the
// network (stale-while-revalidate). Actions that cannot reach the server -
// or while older ones are still queued - stay applied locally and go to the
// offline queue; queued actions are overlaid on lists loaded later.
// Drafts (2.8): the compose form autosaves to the server; saved drafts are
// listed by DraftList at the top of the Drafts folder (their synced IMAP
// copies are hidden there) and continued by clicking them. A message of
// the Drafts folder (e.g. written in another client) gets "Bearbeiten",
// which opens it as a draft. Switching accounts saves an open draft.
// Search (5.1): a search field above the list searches the active account
// at the provider (IMAP SEARCH via GET /api/accounts/:id/search, online
// only). Hits replace the list (same rendering, with their folder); actions
// on a hit run in the folder it was found in. Clearing the search reloads
// the folder. Matches without a local copy are only counted.
// Manual sync (4.8): a refresh button in the list header and pull-to-refresh
// on touch devices (PullToRefresh from @fma/shared) ask the server to sync
// the active account (POST /api/accounts/:id/sync, rate-limited there) and
// reload the list; app.vue then polls the account list while the sync runs,
// and the view reloads again once it finished (same path as 4.5). Disabled
// while offline.
// Sync status (#119): the button spins while the active account's sync is
// queued or running (GET /api/sync/status via app.vue, else `syncing`) and
// stops at once when the sync is stopped; a progress line shows folder and
// "done / total" under the header. SyncPanel next to the button lists all
// accounts with progress, "Stoppen" and "Jetzt synchronisieren" - the
// latter takes the same path as the button (same rate limit and notice).
import {
  PullToRefresh,
  manualSyncNotice,
  RequestScope,
  accountDataChanged,
  accountStatusInfo,
  createDraft,
  isStaleResponse,
  isSyncBusy,
  mergeFirstPage,
  overlayPendingActions,
  parseSearchQuery,
  searchQueryString,
  groupByDate,
  selectRange,
  uniquePeople,
  LAYOUT_LIMITS,
  READING_PANE_CHOICES,
  clampLayoutSize,
  parseLayout,
  GO_TO_ROLE,
  ShortcutMatcher,
  moveCursor,
  syncProgressText,
  syncStatusFromAccounts,
} from '@fma/shared'
import type {
  AccountSummary,
  AccountSyncStatus,
  MailLayout,
  ReadingPane,
  AccountSyncState,
  ComposeDraft,
  ComposeIdentity,
  ComposeMode,
  Draft,
  FolderListResponse,
  FolderSummary,
  MailPerson,
  MessageAction,
  MessageActionRequest,
  MessageDetail,
  MessageListItem,
  MessageListResponse,
  IdentityListResponse,
  OutboxMessage,
  SearchResponse,
  ThreadDetail,
} from '@fma/shared'
import type ComposeForm from './ComposeForm.vue'
import type DraftList from './DraftList.vue'
import type OutboxPanel from './OutboxPanel.vue'
import { cacheGet, cachePut } from '~/utils/offline-store'
import {
  enqueueAction,
  isNetworkError,
  isOffline,
  notifyUnauthorized,
  offlineState,
} from '~/utils/offline-queue'
import { isTypingTarget, shortcutsEnabled } from '~/utils/shortcuts-setting'
import type { Component } from 'vue'
import {
  IconAlertOctagon,
  IconArchive,
  IconArrowBackUp,
  IconFilePencil,
  IconFolder,
  IconInbox,
  IconLayoutColumns,
  IconLayoutList,
  IconLayoutRows,
  IconSend,
  IconFlag,
  IconFlagFilled,
  IconMail,
  IconMailOpened,
  IconPaperclip,
  IconTrash,
} from '@tabler/icons-vue'

type AccountOption = Pick<AccountSummary, 'id' | 'displayName' | 'emailAddress'> &
  Partial<
    Pick<
      AccountSummary,
      | 'unreadCount'
      | 'status'
      | 'lastErrorCode'
      | 'nextRetryAt'
      | 'lastSyncAt'
      | 'syncing'
      | 'credentialKind'
    >
  >

// Account bar (#120): the accounts are listed by AccountRail in app.vue,
// which switches via switchAccount(); `activeAccount` reports the active
// account and its live INBOX unread count back for the bar's badge.
// syncStatus/syncCancelSupported (#119): state per account from app.vue;
// without them (or on a backend without the status endpoint) the state is
// derived from `syncing` and there is no stop button.
const props = defineProps<{
  accounts: AccountOption[]
  syncStatus?: AccountSyncStatus[]
  syncCancelSupported?: boolean
}>()
const emit = defineEmits<{
  editAccount: [id: string]
  syncRequested: []
  activeAccount: [id: string, inboxUnread: number | null]
  cancelSync: [accountId: string | null]
}>()

const SPECIAL_USE_LABELS: Record<string, string> = {
  inbox: 'Posteingang',
  drafts: 'Entwürfe',
  sent: 'Gesendet',
  archive: 'Archiv',
  junk: 'Spam',
  trash: 'Papierkorb',
}
const ACCOUNT_STORAGE_KEY = 'fma.mail.accountId'
/** Messages of a folder list kept offline (three pages of 50). */
const CACHED_LIST_MESSAGES = 150
const LIST_CACHE_DELAY_MS = 500

interface CachedList {
  messages: MessageListItem[]
}

const accountId = ref('')
// Message opened from the unified inbox in another account: opened once
// that account's folders (and its INBOX) are loaded.
let pendingOpen = ''

const folders = ref<FolderSummary[]>([])
const folderId = ref('')
const messages = ref<MessageListItem[]>([])
const nextCursor = ref<string | null>(null)
const listLoading = ref(false)
const detail = ref<MessageDetail | null>(null)
const detailLoading = ref(false)
const thread = ref<ThreadDetail | null>(null)
const expanded = ref(new Set<string>())
const selectedId = ref('')
const error = ref('')
// Mobile: only one pane is visible at a time (list -> detail).
const mobilePane = ref<'list' | 'detail'>('list')
const sentinel = ref<HTMLElement | null>(null)
const identities = ref<ComposeIdentity[]>([])
const compose = ref<{
  accountId: string
  identities: ComposeIdentity[]
  draft: ComposeDraft
  saved?: Draft
  /** Forward: the original, whose attachments the form takes over (5.3). */
  forwardOf?: string
  /** Shown below the conversation in the reading pane (#116). */
  inline?: boolean
} | null>(null)
const composeForm = ref<InstanceType<typeof ComposeForm> | null>(null)
// Search (5.1): criteria of the form and the shown result (null = folder view).
const searchForm = reactive({
  q: '',
  from: '',
  subject: '',
  since: '',
  before: '',
  onlyFolder: false,
})
const showSearchOptions = ref(false)
const search = ref<SearchResponse | null>(null)
const searchLoading = ref(false)
const searchError = ref('')
let searchRequest = 0
const draftList = ref<InstanceType<typeof DraftList> | null>(null)
let composeCounter = 0
const composeKey = ref(0)
const outbox = ref<InstanceType<typeof OutboxPanel> | null>(null)

// Guards against stale responses when the user switches folders quickly.
let listRequest = 0
let detailRequest = 0
// Background refresh (4.5) vs. optimistic actions: no refresh while an
// action request is in flight (it is run afterwards instead), and a refresh
// response is dropped when an action started meanwhile.
let pendingActions = 0
let actionEpoch = 0
let refreshDeferred = false
// Last seen sync state per account, to detect new server data.
const seenSyncState = new Map<string, AccountSyncState>()
let observer: IntersectionObserver | null = null
// Folder whose list is shown (from cache or network) and may be written
// back to the cache; '' while switching, so an empty list never overwrites
// the cached one of the next folder.
let listCacheFolder = ''
let listCacheTimer: ReturnType<typeof setTimeout> | undefined
// Account scope: reset on every account switch. Reads of the previous
// account are aborted, and responses arriving late are dropped (getJson
// rejects with StaleResponseError), so they never land in the new view.
const accountScope = new RequestScope()

const activeAccount = computed(() => props.accounts.find((a) => a.id === accountId.value) ?? null)
const activeStatus = computed(() => (activeAccount.value ? statusInfo(activeAccount.value) : null))

/** Sync state of every account (#119), from the status endpoint or `syncing`. */
const syncStatuses = computed(() =>
  props.syncStatus?.length ? props.syncStatus : syncStatusFromAccounts(props.accounts),
)
const activeSyncStatus = computed(
  () => syncStatuses.value.find((s) => s.accountId === accountId.value) ?? null,
)
/** Progress line of the active account's running sync. */
const activeSyncProgress = computed(() => {
  const status = activeSyncStatus.value
  if (!status || !isSyncBusy(status)) return null
  const folder = folders.value.find((f) => f.id === status.folderId)
  return syncProgressText(status, folder ? folderLabel(folder) : null)
})
/** Manual sync (4.8): request in flight, or the account's sync still queued/running. */
const manualSyncing = ref(false)
const syncBusy = computed(
  () => manualSyncing.value || isSyncBusy(activeSyncStatus.value ?? undefined),
)
const pull = new PullToRefresh()
const pullDistance = ref(0)
const pullArmed = ref(false)
const syncNotice = ref<string | null>(null)
let syncNoticeTimer: ReturnType<typeof setTimeout> | undefined

function showSyncNotice(text: string | null): void {
  clearTimeout(syncNoticeTimer)
  syncNotice.value = text
  if (text) syncNoticeTimer = setTimeout(() => (syncNotice.value = null), 4000)
}

function syncState(account: AccountOption): AccountSyncState {
  return {
    id: account.id,
    lastSyncAt: account.lastSyncAt ?? null,
    syncing: account.syncing ?? false,
    unreadCount: account.unreadCount ?? 0,
  }
}

function statusInfo(account: AccountOption) {
  return accountStatusInfo({
    status: account.status ?? 'ok',
    lastErrorCode: account.lastErrorCode ?? null,
    credentialKind: account.credentialKind,
  })
}

const currentFolder = computed(() => folders.value.find((f) => f.id === folderId.value) ?? null)
const archiveFolder = computed(() => folders.value.find((f) => f.specialUse === 'archive') ?? null)
// Folder the actions of the open message apply to: the current folder, or
// the folder a search hit was found in.
const actionFolder = computed(() => {
  const hitFolder = search.value?.messages.find((m) => m.id === selectedId.value)?.folderId
  return hitFolder ? (folders.value.find((f) => f.id === hitFolder) ?? null) : currentFolder.value
})
const inTrash = computed(() => actionFolder.value?.specialUse === 'trash')
const hasSearchCriteria = computed(() =>
  Boolean(
    searchForm.q || searchForm.from || searchForm.subject || searchForm.since || searchForm.before,
  ),
)
const draftsFolder = computed(
  () => folders.value.find((f) => f.specialUse === 'drafts' && f.selectable) ?? null,
)
const inDraftsFolder = computed(
  () => !!draftsFolder.value && draftsFolder.value.id === folderId.value,
)
// Drafts folder: the IMAP copies of drafts listed by DraftList are hidden.
const visibleMessages = computed(() => {
  const hidden = inDraftsFolder.value && !search.value ? draftList.value?.messageIds : undefined
  if (!hidden || hidden.size === 0) return messages.value
  return messages.value.filter((m) => !hidden.has(m.id))
})
const detailIsDraft = computed(
  () =>
    !!detail.value &&
    !!draftsFolder.value &&
    detail.value.folderIds.includes(draftsFolder.value.id),
)
const moveTargets = computed(() =>
  folders.value.filter((f) => f.selectable && f.id !== (actionFolder.value?.id ?? folderId.value)),
)
// Messages shown in the detail pane: the conversation (with the opened
// message's live object, so optimistic flag changes show) or just the detail.
const shownMessages = computed<MessageDetail[]>(() => {
  const open = detail.value
  if (!open) return []
  const messages = thread.value?.messages ?? []
  if (messages.length < 2 || !messages.some((m) => m.id === open.id)) return [open]
  return messages.map((m) => (m.id === open.id ? open : m))
})

function folderLabel(folder: FolderSummary): string {
  return (folder.specialUse && SPECIAL_USE_LABELS[folder.specialUse]) || folder.name
}

function personLabel(person: MailPerson | null): string {
  if (!person) return '(unbekannt)'
  return person.name || person.address
}

function isExpanded(message: MessageDetail): boolean {
  return shownMessages.value.length < 2 || expanded.value.has(message.id)
}

function toggleExpanded(id: string): void {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

/** One-line preview of a collapsed message. */
function preview(message: MessageDetail): string {
  return (message.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 160)
}

function personList(people: MailPerson[]): string {
  return people.map((p) => (p.name ? `${p.name} <${p.address}>` : p.address)).join(', ')
}

const timeFormat = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' })
const dateFormat = new Intl.DateTimeFormat('de-DE', {
  day: '2-digit',
  month: '2-digit',
  year: '2-digit',
})
const fullFormat = new Intl.DateTimeFormat('de-DE', { dateStyle: 'full', timeStyle: 'short' })

function retryText(account: AccountOption): string {
  if (account.status !== 'unreachable' || !account.nextRetryAt) return ''
  const at = new Date(account.nextRetryAt)
  return at.getTime() > Date.now() ? ` Nächster Versuch: ${timeFormat.format(at)} Uhr.` : ''
}

function shortDate(iso: string): string {
  const date = new Date(iso)
  const today = new Date()
  return date.toDateString() === today.toDateString()
    ? timeFormat.format(date)
    : dateFormat.format(date)
}

function getJson<T>(path: string): Promise<T> {
  return accountScope.run(async (signal) => {
    let res: Response
    try {
      res = await fetch(path, { signal })
    } catch (err) {
      if (!isNetworkError(err)) throw err
      offlineState.reachable = false
      throw new Error('Keine Verbindung zum Server.')
    }
    offlineState.reachable = true
    if (res.status === 401) notifyUnauthorized()
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { message?: string } | null
      throw new Error(body?.message ?? `Fehler ${res.status}`)
    }
    return (await res.json()) as T
  })
}

/** Live INBOX unread count of the active account for the account bar; null until known. */
const activeInboxUnread = computed(() => {
  const inboxes = folders.value.filter((f) => f.specialUse === 'inbox')
  return inboxes.length > 0 ? inboxes.reduce((sum, f) => sum + f.unreadCount, 0) : null
})

watch([accountId, activeInboxUnread], ([id, unread]) => emit('activeAccount', id, unread), {
  immediate: true,
})

/**
 * Switches the active account. An open compose form belongs to the previous
 * account; its draft is saved and the form closed. Returns false when the
 * account is kept.
 */
function switchAccount(id: string): boolean {
  if (!id || id === accountId.value) return true
  pendingOpen = ''
  // The open draft belongs to the previous account: save it, then close.
  void composeForm.value?.flush()
  compose.value = null
  accountId.value = id
  return true
}

function readStoredAccount(): string {
  try {
    return localStorage.getItem(ACCOUNT_STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

function storeAccount(id: string): void {
  try {
    localStorage.setItem(ACCOUNT_STORAGE_KEY, id)
  } catch {
    // storage unavailable (private mode): selection is not remembered
  }
}

async function loadIdentities(): Promise<ComposeIdentity[]> {
  const requestedAccount = accountId.value
  if (!requestedAccount) return []
  try {
    const res = await getJson<IdentityListResponse>(`/api/accounts/${requestedAccount}/identities`)
    if (requestedAccount === accountId.value) identities.value = res.identities
    void cachePut(`identities:${requestedAccount}`, res.identities, {
      accountId: requestedAccount,
      pinned: true,
    })
    return res.identities
  } catch (err) {
    if (isStaleResponse(err)) return []
    // Offline: the cached identities allow writing (the send is queued).
    const cached = await cacheGet<ComposeIdentity[]>(`identities:${requestedAccount}`)
    if (cached && requestedAccount === accountId.value) identities.value = cached
    return cached ?? []
  }
}

/** Opens the compose form; replies/forwards are prefilled from the open message. */
async function openCompose(mode: ComposeMode): Promise<void> {
  if (compose.value) return
  const original = mode === 'new' ? undefined : (detail.value ?? undefined)
  if (mode !== 'new' && !original) return
  const account = original?.accountId ?? accountId.value
  if (!account) return
  const scope = accountScope.token
  // Fresh identities (the signature may have been edited in the settings);
  // the cached list is the fallback when offline.
  const loaded = account === accountId.value ? await loadIdentities() : []
  const list = loaded.length > 0 ? loaded : identities.value
  // Switched accounts meanwhile: never open a draft for the previous one.
  if (compose.value || !accountScope.isCurrent(scope)) return
  composeKey.value = ++composeCounter
  // Replies on wide screens with a reading pane: below the conversation.
  const inline =
    mode !== 'new' &&
    layout.readingPane !== 'off' &&
    window.matchMedia('(min-width: 761px)').matches
  compose.value = {
    accountId: account,
    identities: list,
    draft: createDraft(mode, list, original),
    inline,
    ...(mode === 'forward' && original ? { forwardOf: original.id } : {}),
  }
  if (inline) {
    await nextTick()
    document.getElementById('compose-inline-slot')?.scrollIntoView({ block: 'nearest' })
  }
}

/** Continues a saved draft in the compose form. */
async function openSavedDraft(saved: Draft): Promise<void> {
  if (compose.value || saved.accountId !== accountId.value) return
  const scope = accountScope.token
  const loaded = await loadIdentities()
  const list = loaded.length > 0 ? loaded : identities.value
  if (compose.value || !accountScope.isCurrent(scope)) return
  composeKey.value = ++composeCounter
  compose.value = {
    accountId: saved.accountId,
    identities: list,
    draft: {
      mode: saved.inReplyTo ? 'reply' : 'new',
      identityId: saved.identityId,
      to: [],
      cc: [],
      bcc: [],
      subject: saved.subject,
      text: saved.text,
      ...(saved.inReplyTo ? { inReplyTo: saved.inReplyTo } : {}),
      references: saved.references,
    },
    saved,
  }
}

/**
 * "Bearbeiten" on a message of the Drafts folder: continues the draft it
 * belongs to, or turns a draft of another client into one (online only).
 */
async function editDraftMessage(): Promise<void> {
  const message = detail.value
  if (!message || compose.value) return
  error.value = ''
  try {
    const res = await fetch(`/api/messages/${message.id}/draft`, { method: 'POST' })
    const body = (await res.json().catch(() => null)) as (Draft & { message?: string }) | null
    if (!res.ok || !body) {
      error.value = body?.message ?? `Entwurf konnte nicht geöffnet werden (Fehler ${res.status}).`
      return
    }
    if (message.accountId !== accountId.value) return
    void draftList.value?.reload()
    await openSavedDraft(body)
  } catch (err) {
    if (!isNetworkError(err)) throw err
    error.value = 'Entwürfe aus dem Entwürfe-Ordner können nur online bearbeitet werden.'
  }
}

function onQueued(message: OutboxMessage): void {
  outbox.value?.track(message)
}

async function loadFolders(): Promise<void> {
  error.value = ''
  folders.value = []
  folderId.value = ''
  messages.value = []
  nextCursor.value = null
  closeDetail()
  if (!accountId.value) return
  const requestedAccount = accountId.value
  const scope = accountScope.token
  const network = getJson<FolderListResponse>(`/api/accounts/${requestedAccount}/folders`)
  network.catch(() => {}) // handled below, after the cache read
  // Cached folders first (stale-while-revalidate), the network replaces them.
  const cached = await cacheGet<FolderSummary[]>(`folders:${requestedAccount}`)
  if (cached && accountScope.isCurrent(scope) && folders.value.length === 0) {
    folders.value = cached
    const inbox = defaultFolder(cached)
    if (inbox) void selectFolder(inbox.id)
  }
  try {
    const res = await network
    if (requestedAccount !== accountId.value) return
    folders.value = res.folders
    void cachePut(`folders:${requestedAccount}`, res.folders, {
      accountId: requestedAccount,
      pinned: true,
    })
    if (!folderId.value || !res.folders.some((f) => f.id === folderId.value)) {
      const inbox = defaultFolder(res.folders)
      if (inbox) await selectFolder(inbox.id)
    }
    if (pendingOpen && requestedAccount === accountId.value) {
      const id = pendingOpen
      pendingOpen = ''
      void openMessage(id)
    }
  } catch (err) {
    pendingOpen = ''
    if (isStaleResponse(err) || cached) return
    error.value = err instanceof Error ? err.message : 'Ordner konnten nicht geladen werden.'
  }
}

function defaultFolder(list: FolderSummary[]): FolderSummary | undefined {
  return list.find((f) => f.specialUse === 'inbox') ?? list.find((f) => f.selectable)
}

/** Leaves the search result (without reloading); in-flight searches are dropped. */
function resetSearch(): void {
  searchRequest++
  search.value = null
  searchLoading.value = false
  searchError.value = ''
}

/** Searches the active account at the provider; the hits replace the list. */
async function runSearch(): Promise<void> {
  clearSelection()
  const query = parseSearchQuery({
    q: searchForm.q,
    from: searchForm.from,
    subject: searchForm.subject,
    since: searchForm.since,
    before: searchForm.before,
    folderId: searchForm.onlyFolder ? folderId.value : undefined,
  })
  if (typeof query === 'string') {
    searchError.value = query
    return
  }
  if (navigator.onLine === false) {
    searchError.value = 'Die Suche ist nur online möglich.'
    return
  }
  const account = accountId.value
  const request = ++searchRequest
  // Drop folder loads still in flight; the result is never cached offline.
  listRequest++
  listCacheFolder = ''
  listLoading.value = false
  searchLoading.value = true
  searchError.value = ''
  closeDetail()
  try {
    const res = await getJson<SearchResponse>(
      `/api/accounts/${account}/search?${searchQueryString(query)}`,
    )
    if (request !== searchRequest || account !== accountId.value) return
    search.value = res
    messages.value = res.messages
    nextCursor.value = null
  } catch (err) {
    if (request !== searchRequest || isStaleResponse(err)) return
    searchError.value = err instanceof Error ? err.message : 'Die Suche ist fehlgeschlagen.'
  } finally {
    if (request === searchRequest) searchLoading.value = false
  }
}

/** Ends the search and shows the current folder again. */
function clearSearch(): void {
  const wasActive = search.value !== null
  Object.assign(searchForm, { q: '', from: '', subject: '', since: '', before: '' })
  resetSearch()
  if (wasActive && folderId.value) void selectFolder(folderId.value)
}

function hitFolderLabel(message: MessageListItem): string {
  const id = (message as { folderId?: string }).folderId
  const folder = id ? folders.value.find((f) => f.id === id) : undefined
  return folder ? folderLabel(folder) : ''
}

async function selectFolder(id: string): Promise<void> {
  resetSearch()
  cursorId.value = ''
  clearSelection()
  folderId.value = id
  olderHint.value = ''
  messages.value = []
  nextCursor.value = null
  listCacheFolder = ''
  closeDetail()
  await loadMessages()
}

/** Queued (not yet replayed) actions stay visible on freshly loaded lists. */
function withPending(list: MessageListItem[], folder: string): MessageListItem[] {
  return offlineState.queue.length > 0
    ? overlayPendingActions(list, folder, offlineState.queue)
    : list
}

async function loadMessages(): Promise<void> {
  if (!folderId.value) return
  const request = ++listRequest
  const cursor = nextCursor.value
  const folder = folderId.value
  listLoading.value = true
  error.value = ''
  let fromCache = false
  try {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
    const network = getJson<MessageListResponse>(`/api/folders/${folder}/messages${query}`)
    if (!cursor) {
      network.catch(() => {}) // handled below
      // First page: show the cached list right away, then revalidate.
      const cached = await cacheGet<CachedList>(`list:${folder}`)
      if (cached && request === listRequest && messages.value.length === 0) {
        messages.value = withPending(cached.messages, folder)
        listCacheFolder = folder
        fromCache = true
      }
    }
    const res = await network
    if (request !== listRequest) return
    // The network page replaces the cached list (no cursor for its tail).
    messages.value = withPending(
      cursor ? [...messages.value, ...res.messages] : res.messages,
      folder,
    )
    nextCursor.value = res.nextCursor
    listCacheFolder = folder
    // A fresh first page makes a deferred background refresh unnecessary.
    if (!cursor) refreshDeferred = false
  } catch (err) {
    if (request === listRequest && !isStaleResponse(err) && !fromCache) {
      error.value = err instanceof Error ? err.message : 'Nachrichten konnten nicht geladen werden.'
    }
  } finally {
    if (request === listRequest) {
      listLoading.value = false
      if (refreshDeferred && pendingActions === 0) void refreshView()
    }
  }
}

function loadMore(): void {
  if (!listLoading.value && nextCursor.value) void loadMessages()
}

/** Loading older messages from the provider (roadmap 2.2) is in progress. */
const olderLoading = ref(false)
const olderHint = ref('')

/**
 * Asks the worker to fetch the next batch of older messages of the open
 * folder, waits until the folder's message count grows (or gives up after
 * about a minute) and reloads the list.
 */
async function loadOlder(): Promise<void> {
  const folder = folderId.value
  const requestedAccount = accountId.value
  if (!folder || !requestedAccount || olderLoading.value) return
  olderLoading.value = true
  olderHint.value = ''
  try {
    const before = folders.value.find((f) => f.id === folder)?.total ?? 0
    const res = await fetch(`/api/folders/${folder}/load-older`, { method: 'POST' })
    if (res.status === 401) notifyUnauthorized()
    if (!res.ok) throw new Error(`Fehler ${res.status}`)
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 3000))
      if (folder !== folderId.value || requestedAccount !== accountId.value) return
      const list = await getJson<FolderListResponse>(`/api/accounts/${requestedAccount}/folders`)
      const total = list.folders.find((f) => f.id === folder)?.total ?? 0
      if (total > before) {
        folders.value = list.folders
        await selectFolder(folder)
        return
      }
    }
    olderHint.value = 'Keine älteren Nachrichten gefunden.'
  } catch {
    olderHint.value = 'Ältere Nachrichten konnten nicht geladen werden.'
  } finally {
    olderLoading.value = false
  }
}

async function openMessage(id: string): Promise<void> {
  cursorId.value = id
  const request = ++detailRequest
  selectedId.value = id
  mobilePane.value = 'detail'
  detailLoading.value = true
  detail.value = null
  thread.value = null
  let markedRead = false
  let threadLoading = false
  const show = (message: MessageDetail) => {
    // Keep local flag changes (queued or just sent) over older data.
    const listed = messages.value.find((m) => m.id === id)
    if (listed) message.flags = { ...message.flags, ...listed.flags }
    if (markedRead) message.flags.seen = true
    detail.value = message
    detailLoading.value = false
    // Opening marks as read (written back to the server by the worker).
    if (!message.flags.seen && !markedRead) {
      markedRead = true
      void runAction('read', [id])
    }
    if (!threadLoading && message.threadId && (listed?.threadCount ?? 2) > 1) {
      threadLoading = true
      void loadThread(message.threadId, request)
    }
  }
  const network = getJson<MessageDetail>(`/api/messages/${id}`)
  network.catch(() => {}) // handled below
  // Read before: shown immediately and offline (stale-while-revalidate).
  const cached = await cacheGet<MessageDetail>(`msg:${id}`)
  if (cached && request === detailRequest && !detail.value) show(cached)
  try {
    const res = await network
    if (request !== detailRequest) return
    show(res)
    void cachePut(`msg:${id}`, res, { accountId: res.accountId })
  } catch (err) {
    if (request === detailRequest && !isStaleResponse(err) && !cached) {
      error.value = err instanceof Error ? err.message : 'Nachricht konnte nicht geladen werden.'
    }
  } finally {
    if (request === detailRequest) detailLoading.value = false
  }
}

/** Loads the conversation of the opened message (best effort: single view on errors). */
async function loadThread(threadId: string, request: number): Promise<void> {
  const showThread = (res: ThreadDetail) => {
    thread.value = res
    const newest = res.messages[res.messages.length - 1]
    expanded.value = new Set([selectedId.value, ...(newest ? [newest.id] : [])])
  }
  const network = getJson<ThreadDetail>(`/api/threads/${threadId}`)
  network.catch(() => {}) // handled below
  const cached = await cacheGet<ThreadDetail>(`thread:${threadId}`)
  if (cached && request === detailRequest && !thread.value) showThread(cached)
  try {
    const res = await network
    if (request !== detailRequest) return
    showThread(res)
    void cachePut(`thread:${threadId}`, res, { accountId: res.accountId })
  } catch {
    // The opened message is shown on its own (or the cached conversation).
  }
}

/** Optimistic local effect of an action on list, detail and folder counts. */
function applyLocally(
  action: MessageAction,
  ids: string[],
  sourceFolderId: string,
  targetFolderId?: string,
): void {
  const idSet = new Set(ids)
  const affected = messages.value.filter((m) => idSet.has(m.id))
  const source = folders.value.find((f) => f.id === sourceFolderId) ?? null
  const target = folders.value.find((f) => f.id === targetFolderId) ?? null

  if (action === 'read' || action === 'unread') {
    const seen = action === 'read'
    for (const message of affected) {
      if (message.flags.seen === seen) continue
      message.flags.seen = seen
      if (source) source.unreadCount = Math.max(0, source.unreadCount + (seen ? -1 : 1))
    }
    if (detail.value && idSet.has(detail.value.id)) detail.value.flags.seen = seen
    return
  }
  if (action === 'flag' || action === 'unflag') {
    for (const message of affected) message.flags.flagged = action === 'flag'
    if (detail.value && idSet.has(detail.value.id)) detail.value.flags.flagged = action === 'flag'
    return
  }

  // archive / delete / move: the messages leave the current folder.
  const unread = affected.filter((m) => !m.flags.seen).length
  if (source) {
    source.total = Math.max(0, source.total - affected.length)
    source.unreadCount = Math.max(0, source.unreadCount - unread)
  }
  if (target) {
    target.total += affected.length
    target.unreadCount += unread
  }
  messages.value = messages.value.filter((m) => !idSet.has(m.id))
  if (idSet.has(selectedId.value)) closeDetail()
}

/** Target folder of a move-like action as the API resolves it (for counts). */
function actionTarget(action: MessageAction, targetFolderId?: string): string | undefined {
  if (action === 'move') return targetFolderId
  if (action === 'archive') return archiveFolder.value?.id
  if (action === 'delete' && !inTrash.value) {
    return folders.value.find((f) => f.specialUse === 'trash')?.id
  }
  return undefined
}

async function runAction(
  action: MessageAction,
  ids: string[],
  targetFolderId?: string,
): Promise<void> {
  // A search hit is acted on in the folder it was found in.
  const sourceFolderId = actionFolder.value?.id ?? folderId.value
  if (!sourceFolderId || ids.length === 0) return
  if (action === 'delete' && inTrash.value) {
    const ok = window.confirm(
      ids.length === 1
        ? 'Nachricht endgültig löschen?'
        : `${ids.length} Nachrichten endgültig löschen?`,
    )
    if (!ok) return
  }

  const scope = accountScope.token
  actionEpoch++
  // Snapshot for rollback (plain copies, the list is small).
  const snapshot = {
    folderId: sourceFolderId,
    listFolderId: folderId.value,
    search: search.value,
    messages: messages.value.map((m) => ({ ...m, flags: { ...m.flags } })),
    folders: folders.value.map((f) => ({ ...f })),
    detailId: detail.value?.id ?? '',
    detailFlags: detail.value ? { ...detail.value.flags } : null,
  }
  error.value = ''
  applyLocally(action, ids, sourceFolderId, actionTarget(action, targetFolderId))

  const body: MessageActionRequest = { folderId: snapshot.folderId, messageIds: ids, action }
  if (targetFolderId) body.targetFolderId = targetFolderId
  const account = accountId.value
  if (detail.value && ids.includes(detail.value.id)) {
    void cachePut(`msg:${detail.value.id}`, toRaw(detail.value), { accountId: account })
  }
  // Offline, or older actions still queued (order matters): queue it; the
  // local change stays.
  if (navigator.onLine === false || offlineState.queue.length > 0) {
    await enqueueAction(account, body)
    return
  }
  pendingActions++
  try {
    const res = await fetch('/api/messages/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const payload = (await res.json().catch(() => null)) as { message?: string } | null
      throw new Error(payload?.message ?? `Fehler ${res.status}`)
    }
  } catch (err) {
    // No connection: keep the local change and replay it later.
    if (isNetworkError(err)) {
      offlineState.reachable = false
      await enqueueAction(account, body)
      return
    }
    // Another account is shown by now: nothing of this one to roll back.
    if (!accountScope.isCurrent(scope)) return
    // Roll back only if the user is still looking at the same folder.
    if (folderId.value === snapshot.listFolderId && search.value === snapshot.search) {
      messages.value = snapshot.messages
      folders.value = snapshot.folders
      if (detail.value?.id === snapshot.detailId && snapshot.detailFlags) {
        detail.value.flags = snapshot.detailFlags
      }
    }
    error.value =
      err instanceof Error && err.message
        ? err.message
        : 'Die Aktion konnte nicht ausgeführt werden.'
  } finally {
    pendingActions--
    if (pendingActions === 0 && refreshDeferred) void refreshView()
  }
}

/**
 * Refresh button / pull-to-refresh (4.8): asks the server to sync the
 * active account and reloads the list right away. A rate-limited (429) or
 * skipped request still reloads; app.vue polls while the sync runs.
 */
async function syncActiveAccount(): Promise<void> {
  await syncAccount(accountId.value)
}

/** Same path for the button and "Jetzt synchronisieren" in the sync panel. */
async function syncAccount(id: string): Promise<void> {
  if (!id || manualSyncing.value) return
  if (isOffline.value) {
    showSyncNotice(manualSyncNotice('offline'))
    return
  }
  manualSyncing.value = true
  try {
    const res = await fetch(`/api/accounts/${id}/sync`, { method: 'POST' })
    offlineState.reachable = true
    if (res.status === 401) {
      notifyUnauthorized()
      return
    }
    showSyncNotice(manualSyncNotice(res.status))
    emit('syncRequested')
    if (id === accountId.value) await refreshView()
  } catch (err) {
    if (!isNetworkError(err)) throw err
    offlineState.reachable = false
    showSyncNotice(manualSyncNotice('offline'))
  } finally {
    manualSyncing.value = false
  }
}

/** Top of the list on screen: the list scrolls itself, on mobile the page. */
function listAtTop(event: TouchEvent): boolean {
  const list = event.currentTarget as HTMLElement
  return list.scrollTop <= 0 && window.scrollY <= 0
}

function onPullStart(event: TouchEvent): void {
  const touch = event.touches[0]
  if (!touch || event.touches.length > 1 || syncBusy.value) return
  pull.start(touch.clientY, listAtTop(event))
}

function onPullMove(event: TouchEvent): void {
  const touch = event.touches[0]
  if (!touch) return
  pullDistance.value = pull.move(touch.clientY)
  pullArmed.value = pull.armed
}

function onPullEnd(): void {
  const trigger = pull.end()
  pullDistance.value = 0
  pullArmed.value = false
  if (trigger) void syncActiveAccount()
}

/**
 * Reloads folders (counts) and the first page of the open folder in place
 * after a sync (roadmap 4.5). Quiet: errors keep the current view.
 */
async function refreshView(): Promise<void> {
  const requestedAccount = accountId.value
  // A shown search result stays as it is (no folder list to merge).
  if (!requestedAccount || search.value || searchLoading.value) return
  // No folder open yet (first sync of a new account was still running when
  // the folders were loaded): load them now instead of waiting for a reload.
  if (!folderId.value) {
    if (!listLoading.value) void loadFolders()
    return
  }
  if (pendingActions > 0 || listLoading.value) {
    refreshDeferred = true
    return
  }
  refreshDeferred = false
  const epoch = actionEpoch
  const request = ++listRequest
  const folder = folderId.value
  try {
    const [folderRes, page] = await Promise.all([
      getJson<FolderListResponse>(`/api/accounts/${requestedAccount}/folders`),
      getJson<MessageListResponse>(`/api/folders/${folder}/messages`),
    ])
    if (requestedAccount !== accountId.value || folder !== folderId.value) return
    if (epoch !== actionEpoch) {
      // An action changed the list meanwhile: retry once it is through.
      refreshDeferred = true
      if (pendingActions === 0) void refreshView()
      return
    }
    folders.value = folderRes.folders
    if (!folderRes.folders.some((f) => f.id === folder)) {
      // The open folder is gone (deleted/renamed at the provider).
      const inbox =
        folderRes.folders.find((f) => f.specialUse === 'inbox') ??
        folderRes.folders.find((f) => f.selectable)
      if (inbox) await selectFolder(inbox.id)
      return
    }
    if (request !== listRequest) return
    const merged = mergeFirstPage(
      { messages: messages.value, nextCursor: nextCursor.value },
      { ...page, messages: withPending(page.messages, folder) },
    )
    messages.value = merged.messages
    nextCursor.value = merged.nextCursor
  } catch {
    // Offline or account switched: keep what is shown.
  }
}

function onMoveSelect(event: Event): void {
  const select = event.target as HTMLSelectElement
  const target = select.value
  select.value = ''
  if (target && detail.value) void runAction('move', [detail.value.id], target)
}

// Keyboard shortcuts (#115, table in @fma/shared): j/k move the cursor in
// the list (and open the next message when one is open), Enter/o open,
// Esc/u back, e/y archive, # delete, r/a/f reply/reply all/forward, c new
// mail, s/! flag, Shift+I/Shift+U read/unread, "g" + letter a folder by its
// role; 1-9 (and Ctrl+1-9 in the installed PWA) switch the account. "/" and
// "?" belong to the header. Inactive while typing, inside dialogs/menus and
// when switched off in the settings (per device).
const matcher = new ShortcutMatcher()
// Layout (#113): reading pane right/below/off and the dragged column sizes,
// per device. Wide screens only; phones keep the stacked list -> message.
const LAYOUT_KEY = 'fma.mail.layout'
const layout = reactive<MailLayout>(parseLayout(readLayout()))
const PANE_ICONS: Record<ReadingPane, Component> = {
  right: IconLayoutColumns,
  bottom: IconLayoutRows,
  off: IconLayoutList,
}
const ROLE_ICONS: Record<string, Component> = {
  inbox: IconInbox,
  sent: IconSend,
  drafts: IconFilePencil,
  archive: IconArchive,
  junk: IconAlertOctagon,
  trash: IconTrash,
}

function readLayout(): string | null {
  try {
    return localStorage.getItem(LAYOUT_KEY)
  } catch {
    return null
  }
}

function saveLayout(): void {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(toRaw(layout)))
  } catch {
    // Private mode: only for this session.
  }
}

function setReadingPane(pane: ReadingPane): void {
  layout.readingPane = pane
  saveLayout()
}

function folderIcon(folder: FolderSummary): Component {
  return (folder.specialUse && ROLE_ICONS[folder.specialUse]) || IconFolder
}

type SizeKey = 'folderWidth' | 'listWidth' | 'listHeight'

/** Drag a column border: pointer capture keeps the moves on the handle. */
function startResize(event: PointerEvent, key: SizeKey): void {
  const handle = event.currentTarget as HTMLElement
  handle.setPointerCapture(event.pointerId)
  const vertical = key === 'listHeight'
  const start = vertical ? event.clientY : event.clientX
  const initial = layout[key]
  const move = (e: PointerEvent) => {
    layout[key] = clampLayoutSize(key, initial + (vertical ? e.clientY : e.clientX) - start)
  }
  const stop = () => {
    handle.removeEventListener('pointermove', move)
    handle.removeEventListener('pointerup', stop)
    handle.removeEventListener('pointercancel', stop)
    saveLayout()
  }
  handle.addEventListener('pointermove', move)
  handle.addEventListener('pointerup', stop)
  handle.addEventListener('pointercancel', stop)
  event.preventDefault()
}

/** Arrow keys move a focused column border by 16 px. */
function resizeWithKeys(event: KeyboardEvent, key: SizeKey): void {
  const back = key === 'listHeight' ? 'ArrowUp' : 'ArrowLeft'
  const forward = key === 'listHeight' ? 'ArrowDown' : 'ArrowRight'
  if (event.key !== back && event.key !== forward) return
  event.preventDefault()
  layout[key] = clampLayoutSize(key, layout[key] + (event.key === forward ? 16 : -16))
  saveLayout()
}

/**
 * Addresses for the recipient suggestions (#116): senders and recipients
 * of the loaded list and the open conversation of the active account.
 */
const knownPeople = computed(() =>
  uniquePeople([
    ...messages.value.map((m) => m.from),
    ...(thread.value?.messages ?? []).flatMap((m) => [m.from, ...m.to, ...m.cc]),
    ...(detail.value ? [detail.value.from, ...detail.value.to, ...detail.value.cc] : []),
  ]),
)

/** Keyboard cursor in the list (j/k). */
const cursorId = ref('')

// Multiple selection (#114): checkbox, Shift-click for a range, Ctrl/Cmd-
// click and "x" toggle; bulk actions go through runAction (one request,
// queued offline like single actions). Not in search results (hits may
// live in different folders). Cleared on folder/account switch.
const selected = ref(new Set<string>())
let selectionAnchor = ''
const canArchive = computed(
  () => !!archiveFolder.value && actionFolder.value?.specialUse !== 'archive',
)
const selectionFlagged = computed(() =>
  visibleMessages.value.some((m) => selected.value.has(m.id) && m.flags.flagged),
)
/** Date groups of the folder view; search results stay one plain list. */
const groupedMessages = computed(() =>
  search.value
    ? [{ label: '', messages: visibleMessages.value }]
    : groupByDate(visibleMessages.value),
)

function toggleSelected(id: string, range: boolean): void {
  const next = new Set(selected.value)
  if (range && selectionAnchor) {
    const ids = selectRange(
      visibleMessages.value.map((m) => m.id),
      selectionAnchor,
      id,
    )
    const add = !next.has(id)
    for (const rangeId of ids) {
      if (add) next.add(rangeId)
      else next.delete(rangeId)
    }
  } else if (next.has(id)) {
    next.delete(id)
  } else {
    next.add(id)
  }
  selectionAnchor = id
  selected.value = next
}

function onSelectClick(event: MouseEvent, id: string): void {
  toggleSelected(id, event.shiftKey)
}

/** Shift- or Ctrl/Cmd-click on a row selects instead of opening. */
function onItemClick(event: MouseEvent, id: string): void {
  if (!search.value && (event.shiftKey || event.ctrlKey || event.metaKey)) {
    event.preventDefault()
    toggleSelected(id, event.shiftKey)
    return
  }
  void openMessage(id)
}

function clearSelection(): void {
  selected.value = new Set()
  selectionAnchor = ''
}

async function bulkAction(
  action: 'archive' | 'delete' | 'read' | 'unread' | 'flag',
): Promise<void> {
  const ids = visibleMessages.value.filter((m) => selected.value.has(m.id)).map((m) => m.id)
  if (ids.length === 0) return
  const resolved = action === 'flag' ? (selectionFlagged.value ? 'unflag' : 'flag') : action
  clearSelection()
  await runAction(resolved, ids)
}

// Messages that left the list (moved, synced away) leave the selection.
watch(visibleMessages, (list) => {
  if (selected.value.size === 0) return
  const ids = new Set(list.map((m) => m.id))
  const kept = [...selected.value].filter((id) => ids.has(id))
  if (kept.length !== selected.value.size) selected.value = new Set(kept)
})

async function moveListCursor(step: 1 | -1): Promise<void> {
  const ids = visibleMessages.value.map((m) => m.id)
  const next = moveCursor(ids, cursorId.value || selectedId.value, step)
  if (!next) return
  cursorId.value = next
  if (selectedId.value && next !== selectedId.value) await openMessage(next)
  await nextTick()
  document
    .querySelector(`.messages [data-id="${CSS.escape(next)}"]`)
    ?.scrollIntoView({ block: 'nearest' })
}

/** Archive/delete from the keyboard: the cursor (and an open message) moves on. */
async function removeWithKeyboard(action: 'archive' | 'delete', id: string): Promise<void> {
  const ids = visibleMessages.value.map((m) => m.id)
  const index = ids.indexOf(id)
  const following = ids[index + 1] ?? ids[index - 1] ?? ''
  const wasOpen = selectedId.value === id
  await runAction(action, [id])
  cursorId.value = following
  if (wasOpen && following) await openMessage(following)
}

function onKeydown(event: KeyboardEvent): void {
  if (!shortcutsEnabled.value || event.defaultPrevented || isTypingTarget(event.target)) return
  if ((event.target as HTMLElement | null)?.closest?.('[role="dialog"], [role="menu"]')) return
  if (compose.value) return
  if (/^[1-9]$/.test(event.key) && !event.altKey && !event.shiftKey) {
    const account = props.accounts[Number(event.key) - 1]
    if (account) {
      event.preventDefault()
      switchAccount(account.id)
    }
    return
  }
  const action = matcher.handle(event)
  if (action === 'pending') {
    event.preventDefault()
    return
  }
  // "/" and "?" are handled by the header.
  if (action === null || action === 'search' || action === 'help') return
  const role = GO_TO_ROLE[action]
  if (role) {
    const folder = folders.value.find((f) => f.specialUse === role && f.selectable)
    if (folder) void selectFolder(folder.id)
    event.preventDefault()
    return
  }
  const targetId = detail.value?.id ?? cursorId.value
  const target = visibleMessages.value.find((m) => m.id === targetId) ?? detail.value
  switch (action) {
    case 'next':
    case 'previous':
      void moveListCursor(action === 'next' ? 1 : -1)
      break
    case 'open':
      // Enter on a focused button or link activates that control instead.
      if ((event.target as HTMLElement | null)?.closest?.('button, a, summary, [role="button"]')) {
        return
      }
      if (!cursorId.value || detail.value?.id === cursorId.value) return
      void openMessage(cursorId.value)
      break
    case 'back':
      if (selected.value.size > 0) clearSelection()
      else if (!goBack()) return
      break
    case 'compose':
      void openCompose('new')
      break
    case 'reply':
    case 'replyAll':
    case 'forward':
      if (!detail.value) return
      void openCompose(action)
      break
    case 'archive':
      if (!target || !archiveFolder.value || actionFolder.value?.specialUse === 'archive') return
      void removeWithKeyboard('archive', target.id)
      break
    case 'delete':
      if (!target) return
      void removeWithKeyboard('delete', target.id)
      break
    case 'flag':
      if (!target) return
      void runAction(target.flags.flagged ? 'unflag' : 'flag', [target.id])
      break
    case 'select': {
      const id = cursorId.value || selectedId.value
      if (!id || search.value) return
      toggleSelected(id, false)
      break
    }
    case 'markRead':
    case 'markUnread':
      if (!target) return
      void runAction(action === 'markRead' ? 'read' : 'unread', [target.id])
      break
    default:
      return
  }
  event.preventDefault()
}

function goBack(): boolean {
  if (compose.value) return true
  if (mobilePane.value !== 'detail' && !selectedId.value) return false
  closeDetail()
  return true
}

/**
 * Opens a message from the unified inbox (3.7) in the view of its own
 * account (INBOX), so actions and replies use that account.
 */
async function openFromUnified(account: string, messageId: string): Promise<void> {
  if (account !== accountId.value) {
    switchAccount(account)
    pendingOpen = messageId
    return
  }
  const inbox = defaultFolder(folders.value)
  if (inbox && inbox.id !== folderId.value) await selectFolder(inbox.id)
  await openMessage(messageId)
}

/** Header search (#120): searches the active account like the list's form did. */
function searchFor(query: string): void {
  searchForm.q = query
  void runSearch()
}

defineExpose({ goBack, openFromUnified, switchAccount, searchFor })

function closeDetail(): void {
  detailRequest++
  selectedId.value = ''
  detail.value = null
  thread.value = null
  expanded.value = new Set()
  detailLoading.value = false
  mobilePane.value = 'list'
}

watch(accountId, (id) => {
  resetSearch()
  cursorId.value = ''
  clearSelection()
  matcher.reset()
  Object.assign(searchForm, { q: '', from: '', subject: '', since: '', before: '' })
  // New scope: abort and ignore everything still in flight for the previous
  // account; its selection, thread and compose state are dropped.
  accountScope.reset()
  listRequest++
  listCacheFolder = ''
  listLoading.value = false
  compose.value = null
  storeAccount(id)
  identities.value = []
  void loadFolders()
  void loadIdentities()
})

// Pick a valid account whenever the account list changes (e.g. after adding
// or removing one in the settings), and reload the view when the active
// account has new data on the server (4.5).
watch(
  () => props.accounts,
  (accounts) => {
    const active = accounts.find((a) => a.id === accountId.value)
    const changed = !!active && accountDataChanged(seenSyncState.get(active.id), syncState(active))
    seenSyncState.clear()
    for (const account of accounts) seenSyncState.set(account.id, syncState(account))
    if (active) {
      if (changed) void refreshView()
      return
    }
    const stored = readStoredAccount()
    accountId.value = accounts.find((a) => a.id === stored)?.id ?? accounts[0]?.id ?? ''
  },
  { immediate: true },
)

// Keeps the cached list of the open folder current (loads, merges and
// local actions), debounced; only the first CACHED_LIST_MESSAGES.
watch(
  messages,
  () => {
    clearTimeout(listCacheTimer)
    const folder = listCacheFolder
    if (!folder || folder !== folderId.value) return
    const account = accountId.value
    listCacheTimer = setTimeout(() => {
      if (folder !== listCacheFolder) return
      const list: CachedList = { messages: toRaw(messages.value).slice(0, CACHED_LIST_MESSAGES) }
      void cachePut(`list:${folder}`, list, { accountId: account })
    }, LIST_CACHE_DELAY_MS)
  },
  { deep: true },
)

// Queued actions were replayed (back online): reload with server data.
watch(
  () => offlineState.replayedAt,
  () => void refreshView(),
)

// Infinite scroll: load the next page when the sentinel becomes visible;
// the "Mehr laden" button stays as fallback.
watch(sentinel, (element) => {
  observer?.disconnect()
  if (!element || typeof IntersectionObserver === 'undefined') return
  observer = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) loadMore()
  })
  observer.observe(element)
})

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => {
  accountScope.reset()
  observer?.disconnect()
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div
    class="mail"
    :class="[
      `pane-${mobilePane}`,
      `reading-${layout.readingPane}`,
      { 'has-detail': !!selectedId || detailLoading },
    ]"
    :style="{
      '--folders-w': `${layout.folderWidth}px`,
      '--list-w': `${layout.listWidth}px`,
      '--list-h': `${layout.listHeight}px`,
    }"
  >
    <!-- Column borders, dragged with the mouse or moved with the arrow keys (#113) -->
    <div
      class="resizer resizer-folders"
      role="separator"
      aria-orientation="vertical"
      aria-label="Breite der Ordnerspalte"
      tabindex="0"
      :aria-valuenow="layout.folderWidth"
      :aria-valuemin="LAYOUT_LIMITS.folderWidth.min"
      :aria-valuemax="LAYOUT_LIMITS.folderWidth.max"
      @pointerdown="startResize($event, 'folderWidth')"
      @keydown="resizeWithKeys($event, 'folderWidth')"
    />
    <div
      v-if="layout.readingPane !== 'off'"
      class="resizer resizer-list"
      role="separator"
      :aria-orientation="layout.readingPane === 'bottom' ? 'horizontal' : 'vertical'"
      :aria-label="
        layout.readingPane === 'bottom'
          ? 'Höhe der Nachrichtenliste'
          : 'Breite der Nachrichtenliste'
      "
      tabindex="0"
      :aria-valuenow="layout.readingPane === 'bottom' ? layout.listHeight : layout.listWidth"
      @pointerdown="
        startResize($event, layout.readingPane === 'bottom' ? 'listHeight' : 'listWidth')
      "
      @keydown="
        resizeWithKeys($event, layout.readingPane === 'bottom' ? 'listHeight' : 'listWidth')
      "
    />
    <aside class="sidebar">
      <button type="button" class="primary compose-button" @click="openCompose('new')">
        Neue E-Mail
      </button>
      <nav class="folders" aria-label="Ordner">
        <button
          v-for="folder in folders"
          :key="folder.id"
          type="button"
          class="folder"
          :class="{ active: folder.id === folderId }"
          :style="{ paddingLeft: `${0.6 + folder.depth * 0.9}rem` }"
          :disabled="!folder.selectable"
          @click="selectFolder(folder.id)"
        >
          <component :is="folderIcon(folder)" class="folder-icon" :size="16" aria-hidden="true" />
          <span class="folder-name">{{ folderLabel(folder) }}</span>
          <span v-if="folder.unreadCount > 0" class="count">{{ folder.unreadCount }}</span>
        </button>
      </nav>
      <DraftList
        v-if="accountId && folders.length > 0 && !draftsFolder"
        ref="draftList"
        :account-id="accountId"
        @open="openSavedDraft"
      />
      <OutboxPanel ref="outbox" :account-id="accountId" />
    </aside>

    <section
      class="list"
      aria-label="Nachrichten"
      @touchstart.passive="onPullStart"
      @touchmove.passive="onPullMove"
      @touchend="onPullEnd"
      @touchcancel="onPullEnd"
    >
      <header class="list-header">
        <!-- Mobile replacement for the folder sidebar -->
        <select
          class="mobile-folders"
          :value="folderId"
          @change="selectFolder(($event.target as HTMLSelectElement).value)"
        >
          <option
            v-for="folder in folders"
            :key="folder.id"
            :value="folder.id"
            :disabled="!folder.selectable"
          >
            {{ '  '.repeat(folder.depth) }}{{ folderLabel(folder) }}
            {{ folder.unreadCount > 0 ? `(${folder.unreadCount})` : '' }}
          </option>
        </select>
        <h2 class="desktop-title">
          {{ search ? 'Suchergebnisse' : currentFolder ? folderLabel(currentFolder) : 'Ordner' }}
        </h2>
        <span class="pane-switch" role="group" aria-label="Lesebereich">
          <button
            v-for="choice in READING_PANE_CHOICES"
            :key="choice.value"
            type="button"
            :aria-pressed="layout.readingPane === choice.value ? 'true' : 'false'"
            :aria-label="choice.label"
            :title="choice.label"
            @click="setReadingPane(choice.value)"
          >
            <component :is="PANE_ICONS[choice.value]" :size="18" aria-hidden="true" />
          </button>
        </span>
        <button
          v-if="accountId"
          type="button"
          class="refresh"
          :class="{ spinning: syncBusy }"
          :disabled="isOffline || syncBusy"
          :aria-busy="syncBusy"
          :aria-label="syncBusy ? 'Wird aktualisiert' : 'Aktualisieren'"
          :title="isOffline ? 'Offline – Aktualisieren nicht möglich' : 'Aktualisieren'"
          @click="syncActiveAccount"
        >
          <span aria-hidden="true">&#8635;</span>
        </button>
        <SyncPanel
          v-if="accountId"
          :accounts="accounts"
          :statuses="syncStatuses"
          :can-cancel="syncCancelSupported ?? false"
          :active-account-id="accountId"
          :active-folders="folders"
          :folder-label="folderLabel"
          :disabled="isOffline"
          @cancel="emit('cancelSync', $event)"
          @sync="syncAccount"
          @edit-account="emit('editAccount', $event)"
        />
      </header>
      <p v-if="activeSyncProgress" class="hint sync-progress">{{ activeSyncProgress }}</p>
      <div
        v-if="pullDistance > 0"
        class="pull-indicator"
        :style="{ height: `${pullDistance}px` }"
        aria-hidden="true"
      >
        {{ pullArmed ? 'Loslassen zum Aktualisieren' : 'Ziehen zum Aktualisieren' }}
      </div>
      <p v-if="syncNotice" class="hint sync-notice" role="status">{{ syncNotice }}</p>

      <form v-if="accountId" class="search" aria-label="Suchfilter" @submit.prevent="runSearch">
        <div class="search-row">
          <span v-if="searchForm.q" class="search-query">„{{ searchForm.q }}“</span>
          <button
            type="button"
            class="link"
            :aria-expanded="showSearchOptions"
            @click="showSearchOptions = !showSearchOptions"
          >
            Filter
          </button>
          <button
            v-if="search || searchError || hasSearchCriteria"
            type="button"
            class="link"
            title="Suche beenden"
            aria-label="Suche beenden"
            @click="clearSearch"
          >
            &times;
          </button>
        </div>
        <div v-if="showSearchOptions" class="search-options">
          <label>
            <span>Von</span>
            <input v-model="searchForm.from" type="text" autocomplete="off" />
          </label>
          <label>
            <span>Betreff</span>
            <input v-model="searchForm.subject" type="text" autocomplete="off" />
          </label>
          <label>
            <span>Ab</span>
            <input v-model="searchForm.since" type="date" />
          </label>
          <label>
            <span>Vor dem</span>
            <input v-model="searchForm.before" type="date" />
          </label>
          <label>
            <span>Suchbegriff</span>
            <input v-model="searchForm.q" type="text" autocomplete="off" />
          </label>
          <label class="check">
            <input v-model="searchForm.onlyFolder" type="checkbox" />
            Nur in „{{ currentFolder ? folderLabel(currentFolder) : 'diesem Ordner' }}“
          </label>
          <button type="submit" class="secondary">Suchen</button>
        </div>
      </form>
      <p v-if="searchLoading" class="hint">Suche beim Anbieter &hellip;</p>
      <p v-if="searchError" class="error">{{ searchError }}</p>
      <p v-if="search && !searchLoading" class="search-summary" role="status">
        {{ search.messages.length === 1 ? '1 Treffer' : `${search.messages.length} Treffer`
        }}{{ search.truncated ? ' (weitere vorhanden, Suche eingrenzen)' : '' }}
        <span v-if="search.notSynced > 0">
          &middot; {{ search.notSynced }} weitere Treffer beim Anbieter (noch nicht synchronisiert)
        </span>
        <span v-if="search.foldersFailed > 0">
          &middot; {{ search.foldersFailed }} Ordner konnten nicht durchsucht werden
        </span>
      </p>

      <div v-if="activeAccount && activeStatus" class="account-status" role="status">
        <strong>{{ activeStatus.label }}</strong>
        <span>{{ activeStatus.description }}{{ retryText(activeAccount) }}</span>
        <button
          v-if="activeStatus.action"
          type="button"
          class="secondary"
          @click="emit('editAccount', activeAccount.id)"
        >
          {{ activeStatus.action }}
        </button>
      </div>
      <p v-if="error" class="error">{{ error }}</p>
      <DraftList
        v-if="accountId && inDraftsFolder && !search"
        ref="draftList"
        :account-id="accountId"
        @open="openSavedDraft"
      />
      <p
        v-if="!listLoading && !searchLoading && folderId && visibleMessages.length === 0"
        class="hint"
      >
        {{ search ? 'Keine Treffer.' : 'Keine Nachrichten in diesem Ordner.' }}
      </p>
      <p v-if="folders.length === 0 && !error" class="hint">
        Noch keine Ordner synchronisiert &ndash; der Abgleich läuft im Hintergrund.
      </p>

      <div v-if="selected.size > 0" class="selection-bar" role="toolbar" aria-label="Auswahl">
        <span class="selection-count" role="status">{{ selected.size }} ausgewählt</span>
        <button v-if="canArchive" type="button" class="secondary" @click="bulkAction('archive')">
          <IconArchive :size="16" aria-hidden="true" /> Archivieren
        </button>
        <button type="button" class="secondary danger" @click="bulkAction('delete')">
          <IconTrash :size="16" aria-hidden="true" />
          {{ inTrash ? 'Endgültig löschen' : 'Löschen' }}
        </button>
        <button type="button" class="secondary" @click="bulkAction('read')">Gelesen</button>
        <button type="button" class="secondary" @click="bulkAction('unread')">Ungelesen</button>
        <button type="button" class="secondary" @click="bulkAction('flag')">
          <IconFlag :size="16" aria-hidden="true" />
          {{ selectionFlagged ? 'Markierung entfernen' : 'Markieren' }}
        </button>
        <button type="button" class="link" @click="clearSelection">Auswahl aufheben</button>
      </div>

      <ul class="messages">
        <template v-for="group in groupedMessages" :key="`${group.label}-${group.messages[0]?.id}`">
          <li v-if="group.label" class="date-group" role="presentation">{{ group.label }}</li>
          <li
            v-for="message in group.messages"
            :key="message.id"
            class="message-row"
            :class="{ selected: selected.has(message.id), selectable: !search }"
          >
            <input
              v-if="!search"
              type="checkbox"
              class="select"
              :checked="selected.has(message.id)"
              :aria-label="`Auswählen: ${message.subject || '(kein Betreff)'}`"
              @click="onSelectClick($event, message.id)"
            />
            <button
              type="button"
              class="item"
              :class="{
                unread: !message.flags.seen,
                active: message.id === selectedId,
                cursor: message.id === cursorId && message.id !== selectedId,
              }"
              :data-id="message.id"
              @click="onItemClick($event, message.id)"
            >
              <span class="row">
                <span class="from">{{ personLabel(message.from) }}</span>
                <span class="date">{{ shortDate(message.date) }}</span>
              </span>
              <span class="row">
                <span class="subject">{{ message.subject || '(kein Betreff)' }}</span>
                <span class="icons">
                  <span
                    v-if="message.threadCount > 1"
                    class="thread-count"
                    :title="`${message.threadCount} Nachrichten in der Unterhaltung`"
                    >{{ message.threadCount }}</span
                  >
                  <IconArrowBackUp
                    v-if="message.flags.answered"
                    :size="14"
                    aria-label="Beantwortet"
                    role="img"
                  />
                  <IconPaperclip
                    v-if="message.hasAttachments"
                    :size="14"
                    aria-label="Anhang"
                    role="img"
                  />
                  <IconFlagFilled
                    v-if="message.flags.flagged"
                    class="flagged"
                    :size="14"
                    aria-label="Markiert"
                    role="img"
                  />
                </span>
              </span>
              <span class="snippet">
                <span v-if="search" class="hit-folder">{{ hitFolderLabel(message) }}</span>
                {{ message.snippet }}
              </span>
            </button>
            <!-- Quick actions on hover (mouse); keyboard users have the shortcuts and the toolbar. -->
            <span v-if="!search" class="hover-actions">
              <button
                v-if="canArchive"
                type="button"
                tabindex="-1"
                title="Archivieren (e)"
                aria-label="Archivieren"
                @click="runAction('archive', [message.id])"
              >
                <IconArchive :size="18" aria-hidden="true" />
              </button>
              <button
                type="button"
                tabindex="-1"
                title="Löschen (#)"
                aria-label="Löschen"
                @click="runAction('delete', [message.id])"
              >
                <IconTrash :size="18" aria-hidden="true" />
              </button>
              <button
                type="button"
                tabindex="-1"
                :title="
                  message.flags.seen
                    ? 'Als ungelesen markieren (Shift+U)'
                    : 'Als gelesen markieren (Shift+I)'
                "
                :aria-label="
                  message.flags.seen ? 'Als ungelesen markieren' : 'Als gelesen markieren'
                "
                @click="runAction(message.flags.seen ? 'unread' : 'read', [message.id])"
              >
                <IconMail v-if="message.flags.seen" :size="18" aria-hidden="true" />
                <IconMailOpened v-else :size="18" aria-hidden="true" />
              </button>
              <button
                type="button"
                tabindex="-1"
                :title="message.flags.flagged ? 'Markierung entfernen (s)' : 'Markieren (s)'"
                :aria-label="message.flags.flagged ? 'Markierung entfernen' : 'Markieren'"
                @click="runAction(message.flags.flagged ? 'unflag' : 'flag', [message.id])"
              >
                <IconFlagFilled v-if="message.flags.flagged" :size="18" aria-hidden="true" />
                <IconFlag v-else :size="18" aria-hidden="true" />
              </button>
            </span>
          </li>
        </template>
      </ul>

      <div v-if="nextCursor" ref="sentinel" class="more">
        <button type="button" class="secondary" :disabled="listLoading" @click="loadMore">
          Mehr laden
        </button>
      </div>
      <div v-else-if="folderId && !search && !listLoading" class="more">
        <button type="button" class="secondary" :disabled="olderLoading" @click="loadOlder">
          {{ olderLoading ? 'Ältere Mails werden geladen …' : 'Ältere Mails laden' }}
        </button>
        <p v-if="olderHint" class="hint center">{{ olderHint }}</p>
      </div>
      <p v-if="listLoading" class="hint center">Wird geladen &hellip;</p>
    </section>

    <section class="detail" aria-label="Nachricht">
      <button type="button" class="secondary back" @click="closeDetail">&larr; Zurück</button>
      <p v-if="detailLoading" class="hint">Wird geladen &hellip;</p>
      <article v-else-if="detail">
        <div class="toolbar" role="toolbar" aria-label="Aktionen">
          <button
            v-if="detailIsDraft"
            type="button"
            class="primary"
            title="Entwurf weiter bearbeiten"
            @click="editDraftMessage"
          >
            Bearbeiten
          </button>
          <button
            type="button"
            class="secondary"
            title="Tastenkürzel: r"
            @click="openCompose('reply')"
          >
            Antworten
          </button>
          <button
            type="button"
            class="secondary"
            title="Tastenkürzel: a"
            @click="openCompose('replyAll')"
          >
            Allen antworten
          </button>
          <button
            type="button"
            class="secondary"
            title="Tastenkürzel: f"
            @click="openCompose('forward')"
          >
            Weiterleiten
          </button>
          <button
            type="button"
            class="secondary"
            title="Tastenkürzel: Shift+I / Shift+U"
            @click="runAction(detail.flags.seen ? 'unread' : 'read', [detail.id])"
          >
            {{ detail.flags.seen ? 'Als ungelesen markieren' : 'Als gelesen markieren' }}
          </button>
          <button
            type="button"
            class="secondary"
            :class="{ 'is-flagged': detail.flags.flagged }"
            title="Tastenkürzel: s / !"
            @click="runAction(detail.flags.flagged ? 'unflag' : 'flag', [detail.id])"
          >
            {{ detail.flags.flagged ? 'Markierung entfernen' : 'Markieren' }}
          </button>
          <button
            v-if="archiveFolder && actionFolder?.specialUse !== 'archive'"
            type="button"
            class="secondary"
            title="Tastenkürzel: e / y"
            @click="runAction('archive', [detail.id])"
          >
            Archivieren
          </button>
          <button
            type="button"
            class="secondary danger"
            title="Tastenkürzel: Entf / #"
            @click="runAction('delete', [detail.id])"
          >
            {{ inTrash ? 'Endgültig löschen' : 'Löschen' }}
          </button>
          <label class="move">
            <span class="visually-hidden">Verschieben nach</span>
            <select @change="onMoveSelect">
              <option value="">Verschieben nach &hellip;</option>
              <option v-for="folder in moveTargets" :key="folder.id" :value="folder.id">
                {{ '  '.repeat(folder.depth) }}{{ folderLabel(folder) }}
              </option>
            </select>
          </label>
        </div>
        <h2 class="detail-subject">{{ detail.subject || '(kein Betreff)' }}</h2>
        <p v-if="shownMessages.length > 1" class="thread-info">
          {{ shownMessages.length }} Nachrichten in dieser Unterhaltung
        </p>
        <div
          v-for="message in shownMessages"
          :key="message.id"
          class="thread-message"
          :class="{
            'in-thread': shownMessages.length > 1,
            opened: shownMessages.length > 1 && message.id === detail.id,
          }"
        >
          <button
            v-if="shownMessages.length > 1"
            type="button"
            class="thread-toggle"
            :aria-expanded="isExpanded(message)"
            @click="toggleExpanded(message.id)"
          >
            <span class="row">
              <span class="from">{{ personLabel(message.from) }}</span>
              <span class="date">{{ shortDate(message.date) }}</span>
            </span>
            <span v-if="!isExpanded(message)" class="snippet">{{ preview(message) }}</span>
          </button>
          <template v-if="isExpanded(message)">
            <dl class="headers">
              <dt>Von</dt>
              <dd>{{ message.from ? personList([message.from]) : '(unbekannt)' }}</dd>
              <template v-if="message.to.length">
                <dt>An</dt>
                <dd>{{ personList(message.to) }}</dd>
              </template>
              <template v-if="message.cc.length">
                <dt>Cc</dt>
                <dd>{{ personList(message.cc) }}</dd>
              </template>
              <dt>Datum</dt>
              <dd>{{ fullFormat.format(new Date(message.date)) }}</dd>
            </dl>
            <MessageBody :message="message" />
          </template>
        </div>
      </article>
      <p v-else class="hint empty">Keine Nachricht ausgewählt.</p>
      <!-- Replies open here, below the conversation (#116) -->
      <div id="compose-inline-slot" />
    </section>

    <Teleport to="#compose-inline-slot" defer :disabled="!compose?.inline">
      <ComposeForm
        v-if="compose"
        ref="composeForm"
        :key="composeKey"
        :account-id="compose.accountId"
        :identities="compose.identities"
        :draft="compose.draft"
        :saved="compose.saved"
        :forward-of="compose.forwardOf"
        :known-people="knownPeople"
        :in-pane="layout.readingPane !== 'off'"
        :inline="compose.inline"
        @queued="onQueued"
        @drafts-changed="draftList?.reload()"
        @close="compose = null"
      />
    </Teleport>
  </div>
</template>

<style scoped>
.mail {
  position: relative;
  display: grid;
  grid-template-columns: var(--folders-w, 14rem) var(--list-w, 25rem) minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  grid-template-areas: 'side list detail';
  height: 100%;
  min-height: 0;
  background: var(--color-base-100);
  overflow: hidden;
}

.sidebar,
.list {
  border-right: 1px solid var(--color-base-300);
  overflow-y: auto;
}

.sidebar {
  padding: var(--fma-space-3) var(--fma-space-2);
  background: var(--color-base-200);
}

select {
  width: 100%;
  padding: 0.45rem;
  border: 1px solid var(--fma-border-strong);
  border-radius: var(--fma-radius);
  background: var(--color-base-100);
  font: inherit;
}

.account-status {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.35rem;
  margin: var(--fma-space-3) var(--fma-space-4);
  padding: 0.6rem var(--fma-space-3);
  border: 1px solid var(--fma-warning-border);
  border-radius: var(--fma-radius);
  background: var(--fma-warning-soft);
  color: var(--fma-warning-text);
  font-size: var(--fma-text-sm);
}

.account-status button.secondary {
  padding: var(--fma-space-1) 0.6rem;
  border-color: var(--fma-warning-text);
  color: var(--fma-warning-text);
  font-size: var(--fma-text-sm);
}

button.primary {
  padding: 0.45rem 0.8rem;
  border: 1px solid var(--color-primary);
  border-radius: var(--fma-radius);
  background: var(--color-primary);
  color: var(--color-primary-content);
  font: inherit;
  cursor: pointer;
}

.compose-button {
  width: 100%;
  margin-bottom: var(--fma-space-3);
}

.folder {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
  padding: var(--fma-folder-py) 0.6rem;
  border: none;
  border-radius: var(--fma-radius);
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 0.9rem;
  text-align: left;
  cursor: pointer;
}

.folder:hover:not(:disabled) {
  background: var(--color-base-300);
}

/* Container without messages (IMAP \Noselect, e.g. "[Gmail]"). */
.folder:disabled {
  color: var(--fma-muted);
  cursor: default;
}

.folder.active {
  background: var(--fma-primary-soft);
  color: var(--color-primary);
}

.folder-name {
  flex: 1;
  min-width: 0;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.count {
  margin-left: 0.4rem;
  padding: 0 0.45rem;
  border-radius: 999px;
  background: var(--color-primary);
  color: var(--color-primary-content);
  font-size: var(--fma-text-xs);
}

.list-header {
  position: sticky;
  top: 0;
  display: flex;
  align-items: center;
  gap: var(--fma-space-2);
  padding: var(--fma-space-3) var(--fma-space-4);
  border-bottom: 1px solid var(--color-base-300);
  background: var(--color-base-100);
}

h2 {
  margin: 0;
  font-size: var(--fma-text-lg);
}

.mobile-folders {
  display: none;
}

.list-header h2,
.list-header .mobile-folders {
  flex: 1;
  min-width: 0;
}

.refresh {
  flex: none;
  width: 2.25rem;
  height: 2.25rem;
  padding: 0;
  border: 1px solid var(--fma-border-strong);
  border-radius: var(--fma-radius);
  background: var(--color-base-100);
  color: var(--color-base-content);
  font-size: 1.15rem;
  line-height: 1;
  cursor: pointer;
}

.refresh:disabled {
  cursor: default;
  opacity: 0.55;
}

.refresh.spinning span {
  display: inline-block;
  animation: refresh-spin 1s linear infinite;
}

@keyframes refresh-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .refresh.spinning span {
    animation: none;
  }
}

.item.cursor {
  outline: 2px solid var(--color-primary);
  outline-offset: -2px;
}

.sync-progress {
  margin: var(--fma-space-2) var(--fma-space-4);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sync-notice {
  margin: var(--fma-space-2) var(--fma-space-4);
}

.pull-indicator {
  display: flex;
  align-items: flex-end;
  justify-content: center;
  overflow: hidden;
  color: var(--fma-muted);
  font-size: var(--fma-text-sm);
}

.messages {
  list-style: none;
  margin: 0;
  padding: 0;
}

.message-row {
  position: relative;
  display: flex;
  align-items: stretch;
  border-bottom: 1px solid var(--color-base-200);
}

.message-row .item {
  flex: 1;
  min-width: 0;
  border-bottom: none;
}

.message-row:hover,
.message-row:hover .item {
  background: var(--color-base-200);
}

.message-row:has(.item.active) {
  background: var(--fma-primary-soft);
}

.message-row.selected,
.message-row.selected .item {
  background: var(--fma-primary-soft);
}

.select {
  flex-shrink: 0;
  align-self: center;
  width: 1rem;
  height: 1rem;
  margin: 0 -0.5rem 0 var(--fma-space-3);
  accent-color: var(--color-primary);
}

.date-group {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 0.35rem var(--fma-space-4);
  border-bottom: 1px solid var(--color-base-200);
  background: var(--color-base-200);
  color: var(--fma-muted);
  font-size: var(--fma-text-xs);
  font-weight: 600;
  letter-spacing: 0.03em;
  text-transform: uppercase;
}

/* Quick actions appear over the date/icons of the row on hover. */
.hover-actions {
  position: absolute;
  top: 0.35rem;
  right: 0.5rem;
  display: none;
  gap: 0.15rem;
  padding: 0.1rem;
  border-radius: var(--fma-radius);
  background: var(--color-base-100);
  box-shadow: 0 1px 4px rgb(0 0 0 / 15%);
}

.hover-actions button {
  display: inline-flex;
  padding: 0.3rem;
  border: none;
  border-radius: 0.3rem;
  background: transparent;
  color: var(--fma-muted);
}

.hover-actions button:hover {
  background: var(--color-base-200);
  color: var(--color-base-content);
}

@media (hover: hover) {
  .message-row.selectable:hover .hover-actions {
    display: inline-flex;
  }
}

.selection-bar {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
  padding: var(--fma-space-2) var(--fma-space-3);
  border-bottom: 1px solid var(--fma-border);
  background: var(--fma-primary-soft);
}

.selection-bar button {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: var(--fma-space-1) 0.6rem;
  font-size: var(--fma-text-sm);
}

.selection-count {
  margin-right: auto;
  font-weight: 600;
}

.item {
  display: block;
  width: 100%;
  padding: var(--fma-row-py) var(--fma-row-px);
  border: none;
  border-bottom: 1px solid var(--color-base-200);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.item:hover {
  background: var(--color-base-200);
}

.item.active {
  background: var(--fma-primary-soft);
}

.row {
  display: flex;
  justify-content: space-between;
  gap: var(--fma-space-2);
}

.from,
.subject,
.snippet {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.from {
  font-size: 0.9rem;
}

.item.unread .from,
.item.unread .subject {
  font-weight: 600;
}

.item.unread .from::before {
  content: '';
  display: inline-block;
  width: 0.45rem;
  height: 0.45rem;
  margin-right: 0.4rem;
  border-radius: 50%;
  background: var(--color-primary);
  vertical-align: middle;
}

.date,
.icons {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 0.2rem;
  font-size: var(--fma-text-xs);
  color: var(--fma-muted);
}

.selection-bar button.danger {
  color: var(--color-error);
}

.flagged {
  color: var(--color-error);
}

.subject {
  font-size: 0.875rem;
}

.snippet {
  display: block;
  font-size: 0.8rem;
  color: var(--fma-muted);
}

/* Compact density hides the preview line of list rows. */
.item .snippet {
  display: var(--fma-snippet-display);
}

.more {
  padding: var(--fma-space-3);
  text-align: center;
}

button.secondary {
  padding: 0.4rem 0.8rem;
  border: 1px solid var(--color-primary);
  border-radius: var(--fma-radius);
  background: transparent;
  color: var(--color-primary);
  font: inherit;
  cursor: pointer;
}

.detail {
  padding: var(--fma-space-4) var(--fma-space-5);
  overflow-y: auto;
}

.sidebar {
  grid-area: side;
}

.list {
  grid-area: list;
}

.detail {
  grid-area: detail;
}

/* Layout (#113), wide screens: reading pane below the list or off. */
.mail.reading-bottom {
  grid-template-columns: var(--folders-w, 14rem) minmax(0, 1fr);
  /* A stored height never pushes the message out of a short window. */
  grid-template-rows: minmax(0, min(var(--list-h, 20rem), 50%)) minmax(0, 1fr);
  grid-template-areas:
    'side list'
    'side detail';
}

.mail.reading-bottom .list {
  border-right: none;
  border-bottom: 1px solid var(--color-base-300);
}

.mail.reading-off {
  grid-template-columns: var(--folders-w, 14rem) minmax(0, 1fr);
  grid-template-areas: 'side list';
}

.mail.reading-off .detail {
  display: none;
}

/* Without a reading pane, an open message takes the place of the list. */
.mail.reading-off.has-detail {
  grid-template-areas: 'side detail';
}

.mail.reading-off.has-detail .list {
  display: none;
}

.mail.reading-off.has-detail .detail {
  display: block;
}

.mail.reading-off.has-detail .back {
  display: inline-block;
}

.resizer {
  z-index: 3;
  background: transparent;
  touch-action: none;
}

.resizer:hover,
.resizer:focus-visible {
  background: var(--color-primary);
  outline: none;
}

.resizer-folders,
.resizer-list {
  justify-self: end;
  width: 5px;
  margin-right: -3px;
  cursor: col-resize;
}

.resizer-folders {
  grid-area: side;
}

.resizer-list {
  grid-area: list;
}

.mail.reading-bottom .resizer-list {
  align-self: end;
  justify-self: stretch;
  width: auto;
  height: 5px;
  margin: 0 0 -3px;
  cursor: row-resize;
}

.pane-switch {
  display: inline-flex;
  gap: 0.1rem;
  margin-left: auto;
}

.pane-switch button {
  display: inline-flex;
  padding: 0.3rem;
  border: none;
  border-radius: 0.3rem;
  background: transparent;
  color: var(--fma-muted);
}

.pane-switch button[aria-pressed='true'] {
  background: var(--fma-primary-soft);
  color: var(--color-primary);
}

.folder-icon {
  flex-shrink: 0;
  margin-right: 0.45rem;
  color: var(--fma-muted);
}

.folder.active .folder-icon {
  color: inherit;
}

.back {
  display: none;
  margin-bottom: var(--fma-space-3);
}

.search {
  padding: var(--fma-space-2) var(--fma-space-3);
  border-bottom: 1px solid var(--color-base-300);
}

.search-row {
  display: flex;
  align-items: center;
  gap: 0.35rem;
}

.search-query {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--fma-muted);
  font-size: var(--fma-text-sm);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.search-row .link:first-of-type {
  margin-left: auto;
}

.search input[type='search'] {
  flex: 1;
  min-width: 0;
  padding: 0.35rem var(--fma-space-2);
  border: 1px solid var(--fma-border);
  border-radius: var(--fma-radius);
  font: inherit;
}

.search button.link {
  border: none;
  background: transparent;
  color: var(--color-primary);
  font: inherit;
  font-size: var(--fma-text-sm);
  cursor: pointer;
}

.search-options {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.4rem 0.6rem;
  margin-top: var(--fma-space-2);
  font-size: var(--fma-text-sm);
}

.search-options label {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  color: var(--fma-muted);
}

.search-options label.check {
  flex-direction: row;
  align-items: center;
  grid-column: 1 / -1;
}

.search-options input[type='text'],
.search-options input[type='date'] {
  padding: 0.3rem 0.4rem;
  border: 1px solid var(--fma-border);
  border-radius: var(--fma-radius);
  font: inherit;
}

.search-options button {
  grid-column: 1 / -1;
  justify-self: end;
}

.search-summary {
  margin: 0;
  padding: 0.4rem var(--fma-space-3);
  border-bottom: 1px solid var(--color-base-300);
  font-size: var(--fma-text-sm);
  color: var(--fma-muted);
}

.hit-folder {
  margin-right: 0.35rem;
  padding: 0 0.3rem;
  border-radius: 0.25rem;
  background: var(--color-base-200);
  font-size: var(--fma-text-xs);
  color: var(--color-base-content);
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
  margin-bottom: var(--fma-space-4);
}

.toolbar button.secondary,
.toolbar button.primary {
  padding: 0.3rem 0.65rem;
  font-size: var(--fma-text-sm);
}

.toolbar button.is-flagged {
  border-color: var(--color-error);
  color: var(--color-error);
}

.toolbar button.danger {
  border-color: var(--color-error);
  color: var(--color-error);
}

.toolbar .move select {
  width: auto;
  padding: 0.3rem;
  font-size: var(--fma-text-sm);
}

.thread-count {
  display: inline-block;
  min-width: 1.1rem;
  margin-right: var(--fma-space-1);
  padding: 0 0.3rem;
  border: 1px solid var(--fma-border-strong);
  border-radius: 999px;
  color: var(--fma-muted);
  text-align: center;
}

.thread-info {
  margin: 0 0 var(--fma-space-3);
  font-size: 0.8rem;
  color: var(--fma-muted);
}

.thread-message.in-thread {
  margin-bottom: 0.6rem;
  padding: var(--fma-space-1) var(--fma-space-3) var(--fma-space-2);
  border: 1px solid var(--color-base-300);
  border-radius: var(--fma-radius);
}

.thread-message.opened {
  border-color: var(--fma-primary-soft);
}

.thread-toggle {
  display: block;
  width: 100%;
  padding: 0.4rem 0;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.thread-message.in-thread .headers {
  margin-top: var(--fma-space-1);
}

.detail-subject {
  margin-bottom: var(--fma-space-3);
  font-size: 1.25rem;
}

.headers {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.2rem var(--fma-space-3);
  margin: 0 0 var(--fma-space-4);
  padding-bottom: var(--fma-space-3);
  border-bottom: 1px solid var(--color-base-300);
  font-size: var(--fma-text-sm);
}

.headers dt {
  color: var(--fma-muted);
}

.headers dd {
  margin: 0;
  overflow-wrap: anywhere;
}

.hint {
  margin: var(--fma-space-3) var(--fma-space-4);
  font-size: var(--fma-text-sm);
  color: var(--fma-muted);
}

.hint.center,
.hint.empty {
  text-align: center;
}

.error {
  margin: var(--fma-space-3) var(--fma-space-4);
  font-size: var(--fma-text-sm);
  color: var(--color-error);
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}

/* Mobile: account + folder pickers above the list, list -> detail navigation. */
@media (max-width: 760px) {
  .resizer,
  .pane-switch {
    display: none;
  }

  /* 16px avoids the automatic zoom on focus in iOS Safari. */
  .search input {
    font-size: 16px;
  }

  .mail {
    display: block;
    height: auto;
    min-height: 0;
    padding: 0 var(--fma-space-3);
    overflow: visible;
  }

  .sidebar {
    padding: 0 0 var(--fma-space-2);
    border: none;
    background: transparent;
  }

  .folders,
  .desktop-title {
    display: none;
  }

  .mobile-folders {
    display: block;
  }

  .list {
    border: none;
    overflow: visible;
  }

  .list-header {
    padding: 0 0 var(--fma-space-2);
    border: none;
  }

  .item {
    padding: 0.6rem var(--fma-space-1);
  }

  .back {
    display: inline-block;
  }

  .detail {
    padding: 0;
  }

  .pane-list .detail,
  .pane-detail .sidebar,
  .pane-detail .list {
    display: none;
  }
}
</style>
