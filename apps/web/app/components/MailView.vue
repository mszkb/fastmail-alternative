<script setup lang="ts">
// Inbox and folder view (roadmap 2.3): account picker, folder tree with
// unread counts, paginated message list and a plain-text detail pane.
// Basic actions (2.4): opening a message marks it as read; read/unread,
// flag, archive, delete and move are applied optimistically to the list and
// counts and rolled back if the API refuses them (the server writes them
// back to IMAP in the background). Bodies are shown as text, never as HTML
// (sanitized HTML rendering follows in 2.9).
import type {
  FolderListResponse,
  FolderSummary,
  MailPerson,
  MessageAction,
  MessageActionRequest,
  MessageDetail,
  MessageListItem,
  MessageListResponse,
} from '@fma/shared'

interface AccountOption {
  id: string
  displayName: string
  emailAddress: string
}

const props = defineProps<{ accounts: AccountOption[] }>()

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
const selectedId = ref('')
const error = ref('')
// Mobile: only one pane is visible at a time (list -> detail).
const mobilePane = ref<'list' | 'detail'>('list')
const sentinel = ref<HTMLElement | null>(null)

// Guards against stale responses when the user switches folders quickly.
let listRequest = 0
let detailRequest = 0
let observer: IntersectionObserver | null = null

const currentFolder = computed(() => folders.value.find((f) => f.id === folderId.value) ?? null)
const archiveFolder = computed(() => folders.value.find((f) => f.specialUse === 'archive') ?? null)
const inTrash = computed(() => currentFolder.value?.specialUse === 'trash')
const moveTargets = computed(() => folders.value.filter((f) => f.id !== folderId.value))

function folderLabel(folder: FolderSummary): string {
  return (folder.specialUse && SPECIAL_USE_LABELS[folder.specialUse]) || folder.name
}

function personLabel(person: MailPerson | null): string {
  if (!person) return '(unbekannt)'
  return person.name || person.address
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

function shortDate(iso: string): string {
  const date = new Date(iso)
  const today = new Date()
  return date.toDateString() === today.toDateString()
    ? timeFormat.format(date)
    : dateFormat.format(date)
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path)
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null
    throw new Error(body?.message ?? `Fehler ${res.status}`)
  }
  return (await res.json()) as T
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
  } catch (err) {
    if (request === listRequest) {
      error.value = err instanceof Error ? err.message : 'Nachrichten konnten nicht geladen werden.'
    }
  } finally {
    if (request === listRequest) listLoading.value = false
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
  try {
    const res = await getJson<MessageDetail>(`/api/messages/${id}`)
    if (request !== detailRequest) return
    detail.value = res
    // Opening marks as read (written back to the server by the worker).
    if (!res.flags.seen) void runAction('read', [id])
  } catch (err) {
    if (request === detailRequest) {
      error.value = err instanceof Error ? err.message : 'Nachricht konnte nicht geladen werden.'
    }
  } finally {
    if (request === detailRequest) detailLoading.value = false
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
  }
}

function onMoveSelect(event: Event): void {
  const select = event.target as HTMLSelectElement
  const target = select.value
  select.value = ''
  if (target && detail.value) void runAction('move', [detail.value.id], target)
}

// Keyboard shortcuts for the open message (ignored while typing).
function onKeydown(event: KeyboardEvent): void {
  if (!detail.value || event.ctrlKey || event.metaKey || event.altKey) return
  const element = event.target as HTMLElement | null
  if (element && /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName)) return
  if (element?.isContentEditable) return
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
    default:
      return
  }
  event.preventDefault()
}

function closeDetail(): void {
  detailRequest++
  selectedId.value = ''
  detail.value = null
  detailLoading.value = false
  mobilePane.value = 'list'
}

watch(accountId, (id) => {
  storeAccount(id)
  void loadFolders()
})

// Pick a valid account whenever the account list changes (e.g. after adding
// or removing one in the settings).
watch(
  () => props.accounts,
  (accounts) => {
    if (accounts.some((a) => a.id === accountId.value)) return
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
  observer?.disconnect()
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div class="mail" :class="`pane-${mobilePane}`">
    <aside class="sidebar">
      <label class="account-picker">
        <span class="visually-hidden">Konto</span>
        <select v-model="accountId">
          <option v-for="account in accounts" :key="account.id" :value="account.id">
            {{ account.displayName }}
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
        <dl class="headers">
          <dt>Von</dt>
          <dd>{{ detail.from ? personList([detail.from]) : '(unbekannt)' }}</dd>
          <template v-if="detail.to.length">
            <dt>An</dt>
            <dd>{{ personList(detail.to) }}</dd>
          </template>
          <template v-if="detail.cc.length">
            <dt>Cc</dt>
            <dd>{{ personList(detail.cc) }}</dd>
          </template>
          <dt>Datum</dt>
          <dd>{{ fullFormat.format(new Date(detail.date)) }}</dd>
        </dl>
        <!-- Plain text only: rendered via text interpolation, never v-html. -->
        <pre v-if="detail.text !== null" class="body">{{ detail.text }}</pre>
        <p v-else class="hint">Inhalt wird noch synchronisiert &hellip;</p>
      </article>
      <p v-else class="hint empty">Keine Nachricht ausgewählt.</p>
    </section>
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
  display: block;
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

.body {
  margin: 0;
  font-family: inherit;
  font-size: 0.95rem;
  line-height: 1.5;
  white-space: pre-wrap;
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
