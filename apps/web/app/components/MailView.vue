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
import {
  RequestScope,
  accountDataChanged,
  accountStatusInfo,
  createDraft,
  isStaleResponse,
  mergeFirstPage,
} from '@fma/shared'
import type {
  AccountSummary,
  AccountSyncState,
  ComposeDraft,
  ComposeIdentity,
  ComposeMode,
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
  ThreadDetail,
} from '@fma/shared'
import type OutboxPanel from './OutboxPanel.vue'

type AccountOption = Pick<AccountSummary, 'id' | 'displayName' | 'emailAddress'> &
  Partial<
    Pick<
      AccountSummary,
      'unreadCount' | 'status' | 'lastErrorCode' | 'nextRetryAt' | 'lastSyncAt' | 'syncing'
    >
  >

const props = defineProps<{ accounts: AccountOption[] }>()
const emit = defineEmits<{ editAccount: [id: string] }>()

const SPECIAL_USE_LABELS: Record<string, string> = {
  inbox: 'Posteingang',
  drafts: 'Entwürfe',
  sent: 'Gesendet',
  archive: 'Archiv',
  junk: 'Spam',
  trash: 'Papierkorb',
}
const ACCOUNT_STORAGE_KEY = 'fma.mail.accountId'

const accountId = ref('')
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
} | null>(null)
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
// Account scope: reset on every account switch. Reads of the previous
// account are aborted, and responses arriving late are dropped (getJson
// rejects with StaleResponseError), so they never land in the new view.
const accountScope = new RequestScope()

const activeAccount = computed(() => props.accounts.find((a) => a.id === accountId.value) ?? null)
const activeStatus = computed(() => (activeAccount.value ? statusInfo(activeAccount.value) : null))

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
  })
}

const currentFolder = computed(() => folders.value.find((f) => f.id === folderId.value) ?? null)
const archiveFolder = computed(() => folders.value.find((f) => f.specialUse === 'archive') ?? null)
const inTrash = computed(() => currentFolder.value?.specialUse === 'trash')
const moveTargets = computed(() => folders.value.filter((f) => f.id !== folderId.value))
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
    const res = await fetch(path, { signal })
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { message?: string } | null
      throw new Error(body?.message ?? `Fehler ${res.status}`)
    }
    return (await res.json()) as T
  })
}

/** Unread count shown in the switcher: live folder counts for the active account. */
function accountUnread(account: AccountOption): number {
  if (account.id === accountId.value) {
    const inboxes = folders.value.filter((f) => f.specialUse === 'inbox')
    if (inboxes.length > 0) return inboxes.reduce((sum, f) => sum + f.unreadCount, 0)
  }
  return account.unreadCount ?? 0
}

/**
 * Switches the active account. An open compose form belongs to the previous
 * account and is discarded (after confirmation). Returns false when the user
 * keeps the current account.
 */
function switchAccount(id: string): boolean {
  if (!id || id === accountId.value) return true
  if (
    compose.value &&
    !window.confirm('Der begonnene Entwurf wird verworfen. Trotzdem das Konto wechseln?')
  ) {
    return false
  }
  compose.value = null
  accountId.value = id
  return true
}

function onAccountSelect(event: Event): void {
  const select = event.target as HTMLSelectElement
  if (!switchAccount(select.value)) select.value = accountId.value
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
    return res.identities
  } catch {
    // Offline or a previous account's request: the caller falls back.
    return []
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
  compose.value = { accountId: account, identities: list, draft: createDraft(mode, list, original) }
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
  try {
    const res = await getJson<FolderListResponse>(`/api/accounts/${requestedAccount}/folders`)
    if (requestedAccount !== accountId.value) return
    folders.value = res.folders
    const inbox = res.folders.find((f) => f.specialUse === 'inbox') ?? res.folders[0]
    if (inbox) await selectFolder(inbox.id)
  } catch (err) {
    if (isStaleResponse(err)) return
    error.value = err instanceof Error ? err.message : 'Ordner konnten nicht geladen werden.'
  }
}

async function selectFolder(id: string): Promise<void> {
  folderId.value = id
  messages.value = []
  nextCursor.value = null
  closeDetail()
  await loadMessages()
}

async function loadMessages(): Promise<void> {
  if (!folderId.value) return
  const request = ++listRequest
  const cursor = nextCursor.value
  listLoading.value = true
  error.value = ''
  try {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
    const res = await getJson<MessageListResponse>(
      `/api/folders/${folderId.value}/messages${query}`,
    )
    if (request !== listRequest) return
    messages.value = cursor ? [...messages.value, ...res.messages] : res.messages
    nextCursor.value = res.nextCursor
    // A fresh first page makes a deferred background refresh unnecessary.
    if (!cursor) refreshDeferred = false
  } catch (err) {
    if (request === listRequest && !isStaleResponse(err)) {
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

async function openMessage(id: string): Promise<void> {
  const request = ++detailRequest
  selectedId.value = id
  mobilePane.value = 'detail'
  detailLoading.value = true
  detail.value = null
  thread.value = null
  try {
    const res = await getJson<MessageDetail>(`/api/messages/${id}`)
    if (request !== detailRequest) return
    detail.value = res
    // Opening marks as read (written back to the server by the worker).
    if (!res.flags.seen) void runAction('read', [id])
    const listed = messages.value.find((m) => m.id === id)
    if (res.threadId && (listed?.threadCount ?? 2) > 1) void loadThread(res.threadId, request)
  } catch (err) {
    if (request === detailRequest && !isStaleResponse(err)) {
      error.value = err instanceof Error ? err.message : 'Nachricht konnte nicht geladen werden.'
    }
  } finally {
    if (request === detailRequest) detailLoading.value = false
  }
}

/** Loads the conversation of the opened message (best effort: single view on errors). */
async function loadThread(threadId: string, request: number): Promise<void> {
  try {
    const res = await getJson<ThreadDetail>(`/api/threads/${threadId}`)
    if (request !== detailRequest) return
    thread.value = res
    const newest = res.messages[res.messages.length - 1]
    expanded.value = new Set([selectedId.value, ...(newest ? [newest.id] : [])])
  } catch {
    // The opened message is shown on its own.
  }
}

/** Optimistic local effect of an action on list, detail and folder counts. */
function applyLocally(action: MessageAction, ids: string[], targetFolderId?: string): void {
  const idSet = new Set(ids)
  const affected = messages.value.filter((m) => idSet.has(m.id))
  const source = currentFolder.value
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
  if (!folderId.value || ids.length === 0) return
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
    folderId: folderId.value,
    messages: messages.value.map((m) => ({ ...m, flags: { ...m.flags } })),
    folders: folders.value.map((f) => ({ ...f })),
    detailId: detail.value?.id ?? '',
    detailFlags: detail.value ? { ...detail.value.flags } : null,
  }
  error.value = ''
  applyLocally(action, ids, actionTarget(action, targetFolderId))

  const body: MessageActionRequest = { folderId: snapshot.folderId, messageIds: ids, action }
  if (targetFolderId) body.targetFolderId = targetFolderId
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
    // Another account is shown by now: nothing of this one to roll back.
    if (!accountScope.isCurrent(scope)) return
    // Roll back only if the user is still looking at the same folder.
    if (folderId.value === snapshot.folderId) {
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
 * Reloads folders (counts) and the first page of the open folder in place
 * after a sync (roadmap 4.5). Quiet: errors keep the current view.
 */
async function refreshView(): Promise<void> {
  const requestedAccount = accountId.value
  if (!requestedAccount || !folderId.value) return
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
      const inbox = folderRes.folders.find((f) => f.specialUse === 'inbox') ?? folderRes.folders[0]
      if (inbox) await selectFolder(inbox.id)
      return
    }
    if (request !== listRequest) return
    const merged = mergeFirstPage({ messages: messages.value, nextCursor: nextCursor.value }, page)
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

function isTyping(event: KeyboardEvent): boolean {
  const element = event.target as HTMLElement | null
  if (element && /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName)) return true
  return !!element?.isContentEditable
}

// Keyboard shortcuts (ignored while typing): 1-9 / Ctrl+1-9 switch the
// account (Ctrl+digit only reaches the page in the installed PWA; browsers
// use it for tabs), the rest acts on the open message.
function onKeydown(event: KeyboardEvent): void {
  if (isTyping(event)) return
  if (/^[1-9]$/.test(event.key) && !event.altKey && !event.shiftKey) {
    const account = props.accounts[Number(event.key) - 1]
    if (account) {
      event.preventDefault()
      switchAccount(account.id)
    }
    return
  }
  if (!detail.value || compose.value || event.ctrlKey || event.metaKey || event.altKey) return
  const id = detail.value.id
  switch (event.key) {
    case 'u':
      void runAction(detail.value.flags.seen ? 'unread' : 'read', [id])
      break
    case 's':
      void runAction(detail.value.flags.flagged ? 'unflag' : 'flag', [id])
      break
    case 'e':
      if (archiveFolder.value && currentFolder.value?.specialUse !== 'archive') {
        void runAction('archive', [id])
      }
      break
    case '#':
    case 'Delete':
      void runAction('delete', [id])
      break
    case 'r':
      void openCompose('reply')
      break
    case 'a':
      void openCompose('replyAll')
      break
    case 'f':
      void openCompose('forward')
      break
    default:
      return
  }
  event.preventDefault()
}

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
  // New scope: abort and ignore everything still in flight for the previous
  // account; its selection, thread and compose state are dropped.
  accountScope.reset()
  listRequest++
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
  <div class="mail" :class="`pane-${mobilePane}`">
    <aside class="sidebar">
      <button type="button" class="primary compose-button" @click="openCompose('new')">
        Neue E-Mail
      </button>
      <nav class="accounts" aria-label="Konten">
        <button
          v-for="(account, index) in accounts"
          :key="account.id"
          type="button"
          class="account"
          :class="{ active: account.id === accountId }"
          :aria-current="account.id === accountId ? 'true' : undefined"
          :title="`${account.emailAddress}${index < 9 ? ` – Tastenkürzel: ${index + 1}` : ''}`"
          @click="switchAccount(account.id)"
        >
          <span class="account-name">{{ account.displayName }}</span>
          <span
            v-if="statusInfo(account)"
            class="status-badge"
            :class="account.status"
            :title="statusInfo(account)!.label"
            role="img"
            :aria-label="statusInfo(account)!.label"
            >!</span
          >
          <span
            v-if="accountUnread(account) > 0"
            class="count"
            :aria-label="`${accountUnread(account)} ungelesen`"
            >{{ accountUnread(account) }}</span
          >
        </button>
      </nav>
      <!-- Mobile: compact account switcher -->
      <label class="account-picker">
        <span class="visually-hidden">Konto</span>
        <select :value="accountId" @change="onAccountSelect">
          <option v-for="account in accounts" :key="account.id" :value="account.id">
            {{ account.displayName
            }}{{ accountUnread(account) > 0 ? ` (${accountUnread(account)})` : ''
            }}{{ statusInfo(account) ? ` – ${statusInfo(account)!.label}` : '' }}
          </option>
        </select>
      </label>
      <nav class="folders" aria-label="Ordner">
        <button
          v-for="folder in folders"
          :key="folder.id"
          type="button"
          class="folder"
          :class="{ active: folder.id === folderId }"
          :style="{ paddingLeft: `${0.6 + folder.depth * 0.9}rem` }"
          @click="selectFolder(folder.id)"
        >
          <span class="folder-name">{{ folderLabel(folder) }}</span>
          <span v-if="folder.unreadCount > 0" class="count">{{ folder.unreadCount }}</span>
        </button>
      </nav>
      <OutboxPanel ref="outbox" :account-id="accountId" />
    </aside>

    <section class="list" aria-label="Nachrichten">
      <header class="list-header">
        <!-- Mobile replacement for the folder sidebar -->
        <select
          class="mobile-folders"
          :value="folderId"
          @change="selectFolder(($event.target as HTMLSelectElement).value)"
        >
          <option v-for="folder in folders" :key="folder.id" :value="folder.id">
            {{ '  '.repeat(folder.depth) }}{{ folderLabel(folder) }}
            {{ folder.unreadCount > 0 ? `(${folder.unreadCount})` : '' }}
          </option>
        </select>
        <h2 class="desktop-title">{{ currentFolder ? folderLabel(currentFolder) : 'Ordner' }}</h2>
      </header>

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
      <p v-if="!listLoading && folderId && messages.length === 0" class="hint">
        Keine Nachrichten in diesem Ordner.
      </p>
      <p v-if="folders.length === 0 && !error" class="hint">
        Noch keine Ordner synchronisiert &ndash; der Abgleich läuft im Hintergrund.
      </p>

      <ul class="messages">
        <li v-for="message in messages" :key="message.id">
          <button
            type="button"
            class="item"
            :class="{ unread: !message.flags.seen, active: message.id === selectedId }"
            @click="openMessage(message.id)"
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
                <span v-if="message.flags.answered" title="Beantwortet">&#8617;</span>
                <span v-if="message.hasAttachments" title="Anhang">&#128206;</span>
                <span v-if="message.flags.flagged" class="flagged" title="Markiert">&#9873;</span>
              </span>
            </span>
            <span class="snippet">{{ message.snippet }}</span>
          </button>
        </li>
      </ul>

      <div v-if="nextCursor" ref="sentinel" class="more">
        <button type="button" class="secondary" :disabled="listLoading" @click="loadMore">
          Mehr laden
        </button>
      </div>
      <p v-if="listLoading" class="hint center">Wird geladen &hellip;</p>
    </section>

    <section class="detail" aria-label="Nachricht">
      <button type="button" class="secondary back" @click="closeDetail">&larr; Zurück</button>
      <p v-if="detailLoading" class="hint">Wird geladen &hellip;</p>
      <article v-else-if="detail">
        <div class="toolbar" role="toolbar" aria-label="Aktionen">
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
            title="Tastenkürzel: u"
            @click="runAction(detail.flags.seen ? 'unread' : 'read', [detail.id])"
          >
            {{ detail.flags.seen ? 'Als ungelesen markieren' : 'Als gelesen markieren' }}
          </button>
          <button
            type="button"
            class="secondary"
            :class="{ 'is-flagged': detail.flags.flagged }"
            title="Tastenkürzel: s"
            @click="runAction(detail.flags.flagged ? 'unflag' : 'flag', [detail.id])"
          >
            {{ detail.flags.flagged ? 'Markierung entfernen' : 'Markieren' }}
          </button>
          <button
            v-if="archiveFolder && currentFolder?.specialUse !== 'archive'"
            type="button"
            class="secondary"
            title="Tastenkürzel: e"
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
    </section>

    <ComposeForm
      v-if="compose"
      :key="composeKey"
      :account-id="compose.accountId"
      :identities="compose.identities"
      :draft="compose.draft"
      @queued="onQueued"
      @close="compose = null"
    />
  </div>
</template>

<style scoped>
.mail {
  display: grid;
  grid-template-columns: 14rem minmax(18rem, 24rem) 1fr;
  height: calc(100vh - 7rem);
  min-height: 24rem;
  border: 1px solid #d5dde5;
  border-radius: 0.5rem;
  background: #fff;
  overflow: hidden;
}

.sidebar,
.list {
  border-right: 1px solid #e4e9ee;
  overflow-y: auto;
}

.sidebar {
  padding: 0.75rem 0.5rem;
  background: #f7f9fb;
}

select {
  width: 100%;
  padding: 0.45rem;
  border: 1px solid #b8c2cc;
  border-radius: 0.375rem;
  background: #fff;
  font: inherit;
}

.account-picker {
  display: none;
  margin-bottom: 0.75rem;
}

.accounts {
  margin-bottom: 0.75rem;
  padding-bottom: 0.5rem;
  border-bottom: 1px solid #e4e9ee;
}

.account {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
  padding: 0.4rem 0.6rem;
  border: none;
  border-radius: 0.375rem;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 0.9rem;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
}

.account:hover {
  background: #e4e9ee;
}

.account.active {
  background: #1f2933;
  color: #fff;
}

.status-badge {
  flex-shrink: 0;
  margin-left: auto;
  margin-right: 0.3rem;
  padding: 0 0.4rem;
  border-radius: 999px;
  background: #b45309;
  color: #fff;
  font-size: 0.75rem;
  font-weight: 700;
}

.status-badge.auth_error {
  background: #cf1124;
}

.account-status {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.35rem;
  margin: 0.75rem 1rem;
  padding: 0.6rem 0.75rem;
  border: 1px solid #f5c26b;
  border-radius: 0.375rem;
  background: #fffbeb;
  color: #7c2d12;
  font-size: 0.85rem;
}

.account-status button.secondary {
  padding: 0.25rem 0.6rem;
  border-color: #7c2d12;
  color: #7c2d12;
  font-size: 0.85rem;
}

.account-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

button.primary {
  padding: 0.45rem 0.8rem;
  border: 1px solid #1273de;
  border-radius: 0.375rem;
  background: #1273de;
  color: #fff;
  font: inherit;
  cursor: pointer;
}

.compose-button {
  width: 100%;
  margin-bottom: 0.75rem;
}

.folder {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
  padding: 0.4rem 0.6rem;
  border: none;
  border-radius: 0.375rem;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 0.9rem;
  text-align: left;
  cursor: pointer;
}

.folder:hover {
  background: #e4e9ee;
}

.folder.active {
  background: #dbeafe;
  color: #0b4f9c;
}

.folder-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.count {
  margin-left: 0.4rem;
  padding: 0 0.45rem;
  border-radius: 999px;
  background: #1273de;
  color: #fff;
  font-size: 0.75rem;
}

.list-header {
  position: sticky;
  top: 0;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid #e4e9ee;
  background: #fff;
}

h2 {
  margin: 0;
  font-size: 1.1rem;
}

.mobile-folders {
  display: none;
}

.messages {
  list-style: none;
  margin: 0;
  padding: 0;
}

.item {
  display: block;
  width: 100%;
  padding: 0.6rem 1rem;
  border: none;
  border-bottom: 1px solid #eef2f6;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.item:hover {
  background: #f7f9fb;
}

.item.active {
  background: #dbeafe;
}

.row {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
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
  background: #1273de;
  vertical-align: middle;
}

.date,
.icons {
  flex-shrink: 0;
  font-size: 0.75rem;
  color: #52606d;
}

.flagged {
  color: #cf1124;
}

.subject {
  font-size: 0.875rem;
}

.snippet {
  display: block;
  font-size: 0.8rem;
  color: #52606d;
}

.more {
  padding: 0.75rem;
  text-align: center;
}

button.secondary {
  padding: 0.4rem 0.8rem;
  border: 1px solid #1273de;
  border-radius: 0.375rem;
  background: transparent;
  color: #1273de;
  font: inherit;
  cursor: pointer;
}

.detail {
  padding: 1rem 1.5rem;
  overflow-y: auto;
}

.back {
  display: none;
  margin-bottom: 0.75rem;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
  margin-bottom: 1rem;
}

.toolbar button.secondary {
  padding: 0.3rem 0.65rem;
  font-size: 0.85rem;
}

.toolbar button.is-flagged {
  border-color: #cf1124;
  color: #cf1124;
}

.toolbar button.danger {
  border-color: #9b1c1c;
  color: #9b1c1c;
}

.toolbar .move select {
  width: auto;
  padding: 0.3rem;
  font-size: 0.85rem;
}

.thread-count {
  display: inline-block;
  min-width: 1.1rem;
  margin-right: 0.25rem;
  padding: 0 0.3rem;
  border: 1px solid #b8c2cc;
  border-radius: 999px;
  color: #3e4c59;
  text-align: center;
}

.thread-info {
  margin: 0 0 0.75rem;
  font-size: 0.8rem;
  color: #52606d;
}

.thread-message.in-thread {
  margin-bottom: 0.6rem;
  padding: 0.25rem 0.75rem 0.5rem;
  border: 1px solid #e4e9ee;
  border-radius: 0.375rem;
}

.thread-message.opened {
  border-color: #93c5fd;
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
  margin-top: 0.25rem;
}

.detail-subject {
  margin-bottom: 0.75rem;
  font-size: 1.25rem;
}

.headers {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.2rem 0.75rem;
  margin: 0 0 1rem;
  padding-bottom: 0.75rem;
  border-bottom: 1px solid #e4e9ee;
  font-size: 0.85rem;
}

.headers dt {
  color: #52606d;
}

.headers dd {
  margin: 0;
  overflow-wrap: anywhere;
}

.hint {
  margin: 0.75rem 1rem;
  font-size: 0.85rem;
  color: #52606d;
}

.hint.center,
.hint.empty {
  text-align: center;
}

.error {
  margin: 0.75rem 1rem;
  font-size: 0.85rem;
  color: #9b1c1c;
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
  .mail {
    display: block;
    height: auto;
    min-height: 0;
    border: none;
    overflow: visible;
  }

  .sidebar {
    padding: 0 0 0.5rem;
    border: none;
    background: transparent;
  }

  .folders,
  .accounts,
  .desktop-title {
    display: none;
  }

  .mobile-folders,
  .account-picker {
    display: block;
  }

  .list {
    border: none;
    overflow: visible;
  }

  .list-header {
    padding: 0 0 0.5rem;
    border: none;
  }

  .item {
    padding: 0.6rem 0.25rem;
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
