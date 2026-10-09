<script setup lang="ts">
// Global search (#121): the search field in the header searches all
// accounts at their providers (GET /api/search, IMAP SEARCH, online only).
// The text may carry operators (from:, to:, subject:, before:, after:,
// has:attachment, is:unread; parseSearchInput from @fma/shared). Hits of all
// accounts come merged by date, each with its account icon and folder, the
// terms highlighted in the subject (text parts, no HTML). More hits load
// while scrolling (IntersectionObserver on the end of the list, a button as
// fallback); long lists stay smooth because rows off screen are not laid out
// (content-visibility). Accounts that failed get a line with the reason and
// "Erneut versuchen". A new search or closing aborts the request in flight
// (AbortController), late answers are dropped. Opening a hit hands it to the
// mail view of its account, in the folder it was found in, so actions and
// replies use that account; hits without a local copy yet cannot be opened.
import {
  FOLDER_ROLE_LABELS,
  isFolderRole,
  accountColor,
  accountInitials,
  globalSearchPath,
  highlightParts,
  highlightTerms,
  parseSearchInput,
  parseSearchQuery,
  searchAccountProblem,
} from '@fma/shared'
import type {
  AccountSummary,
  FolderListResponse,
  FolderSummary,
  GlobalSearchAccount,
  GlobalSearchItem,
  GlobalSearchResponse,
  GlobalSearchScope,
  MailPerson,
  SearchQuery,
} from '@fma/shared'
import { isOffline } from '~/utils/offline-queue'

const props = defineProps<{
  accounts: Pick<AccountSummary, 'id' | 'displayName' | 'emailAddress'>[]
  /** Text of the header search field. */
  text: string
  /** Account and folder shown in the mail view (scopes "Nur dieses Konto/Ordner"). */
  activeAccountId: string
  activeFolderId: string
}>()
const emit = defineEmits<{
  open: [accountId: string, folderId: string, messageId: string]
  close: []
}>()

const scope = ref<GlobalSearchScope>('all')
const messages = ref<GlobalSearchItem[]>([])
const accountResults = ref<GlobalSearchAccount[]>([])
const total = ref(0)
const nextCursor = ref<string | null>(null)
const loading = ref(false)
const error = ref('')
const query = ref<SearchQuery | null>(null)
let request = 0
let controller: AbortController | null = null

const terms = computed(() => (query.value ? highlightTerms(query.value) : []))

const accountInfo = computed(() => {
  const info = new Map<string, { initials: string; color: string; name: string }>()
  for (const account of props.accounts) {
    info.set(account.id, {
      initials: accountInitials(account.displayName, account.emailAddress),
      color: accountColor(account.id),
      name: account.displayName || account.emailAddress,
    })
  }
  return info
})

const problems = computed(() =>
  accountResults.value
    .map((entry) => ({ entry, text: searchAccountProblem(entry) }))
    .filter((p): p is { entry: GlobalSearchAccount; text: string } => p.text !== null),
)

const rangeText = computed(() => {
  if (messages.value.length === 0) return ''
  const shown = messages.value.length
  // `total` counts per folder; never show fewer than what is listed.
  const all = Math.max(total.value, shown)
  return nextCursor.value === null && shown === all
    ? `${shown} Treffer`
    : `1–${shown} von ca. ${all.toLocaleString('de-DE')}`
})

// Folder names per account, loaded once for the accounts that have hits.
const folderNames = reactive(new Map<string, Map<string, string>>())
const folderLoads = new Set<string>()

function loadFolders(accountId: string): void {
  if (folderLoads.has(accountId)) return
  folderLoads.add(accountId)
  void fetch(`/api/accounts/${accountId}/folders`)
    .then((res) => (res.ok ? (res.json() as Promise<FolderListResponse>) : null))
    .then((body) => {
      if (!body) return
      const names = new Map<string, string>()
      for (const folder of body.folders) names.set(folder.id, folderName(folder))
      folderNames.set(accountId, names)
    })
    .catch(() => folderLoads.delete(accountId))
}

function folderName(folder: FolderSummary): string {
  if (folder.specialUse === 'inbox') return 'Posteingang'
  return (isFolderRole(folder.specialUse) && FOLDER_ROLE_LABELS[folder.specialUse]) || folder.name
}

function personLabel(person: MailPerson | null): string {
  if (!person) return '(unbekannt)'
  return person.name || person.address
}

const timeFormat = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' })
const dateFormat = new Intl.DateTimeFormat('de-DE', {
  day: '2-digit',
  month: '2-digit',
  year: '2-digit',
})

function shortDate(iso: string): string {
  const date = new Date(iso)
  return date.toDateString() === new Date().toDateString()
    ? timeFormat.format(date)
    : dateFormat.format(date)
}

/** Starts a new search for the current text and scope (aborts the previous one). */
async function search(): Promise<void> {
  controller?.abort()
  const current = ++request
  messages.value = []
  accountResults.value = []
  total.value = 0
  nextCursor.value = null
  error.value = ''
  const parsed = parseSearchQuery(parseSearchInput(props.text) as Record<string, unknown>)
  if (typeof parsed === 'string') {
    query.value = null
    loading.value = false
    error.value = parsed
    return
  }
  query.value = parsed
  await load(current, null)
}

async function more(): Promise<void> {
  if (loading.value || !nextCursor.value) return
  await load(request, nextCursor.value)
}

async function load(current: number, cursor: string | null): Promise<void> {
  if (!query.value) return
  if (isOffline.value) {
    error.value = 'Die Suche braucht eine Verbindung zum Server.'
    return
  }
  controller = new AbortController()
  const signal = controller.signal
  loading.value = true
  try {
    const res = await fetch(
      globalSearchPath(query.value, {
        scope: scope.value,
        accountId: props.activeAccountId,
        folderId: props.activeFolderId,
        cursor,
      }),
      { signal },
    )
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { message?: string } | null
      throw new Error(body?.message ?? `Fehler ${res.status}`)
    }
    const body = (await res.json()) as GlobalSearchResponse
    if (current !== request) return
    messages.value = cursor ? [...messages.value, ...body.messages] : body.messages
    accountResults.value = body.accounts
    total.value = body.total
    nextCursor.value = body.nextCursor
    for (const id of new Set(body.messages.map((m) => m.accountId))) loadFolders(id)
  } catch (err) {
    if (current !== request || signal.aborted) return
    error.value = isOffline.value
      ? 'Die Suche braucht eine Verbindung zum Server.'
      : err instanceof Error
        ? err.message
        : 'Die Suche ist fehlgeschlagen.'
  } finally {
    if (current === request) loading.value = false
  }
}

function close(): void {
  controller?.abort()
  request++
  emit('close')
}

function open(item: GlobalSearchItem): void {
  if (item.id) emit('open', item.accountId, item.folderId, item.id)
}

// Load more when the end of the list comes into view.
const sentinel = ref<HTMLElement | null>(null)
let observer: IntersectionObserver | null = null

onMounted(() => {
  if (typeof IntersectionObserver !== 'undefined') {
    observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void more()
      },
      { rootMargin: '400px' },
    )
    watch(
      sentinel,
      (el, old) => {
        if (old) observer?.unobserve(old)
        if (el) observer?.observe(el)
      },
      { immediate: true },
    )
  }
  void search()
})

onBeforeUnmount(() => {
  observer?.disconnect()
  controller?.abort()
  request++
})

watch(
  () => props.text,
  () => void search(),
)
watch(scope, () => void search())

defineExpose({ search })
</script>

<template>
  <section class="global-search" aria-label="Suche in allen Konten">
    <header class="header">
      <h2>Suche</h2>
      <fieldset class="scope" aria-label="Suchbereich">
        <label
          ><input v-model="scope" type="radio" name="search-scope" value="all" /> Alle Konten</label
        >
        <label
          ><input
            v-model="scope"
            type="radio"
            name="search-scope"
            value="account"
            :disabled="!activeAccountId"
          />
          Nur dieses Konto</label
        >
        <label
          ><input
            v-model="scope"
            type="radio"
            name="search-scope"
            value="folder"
            :disabled="!activeFolderId"
          />
          Nur dieser Ordner</label
        >
      </fieldset>
      <button type="button" class="secondary" @click="close">Suche beenden</button>
    </header>

    <p class="summary" role="status">
      <template v-if="loading && messages.length === 0">Suche läuft …</template>
      <template v-else-if="rangeText">{{ rangeText }}</template>
    </p>

    <ul v-if="problems.length" class="problems">
      <li v-for="problem in problems" :key="problem.entry.accountId" class="message error">
        <span
          >{{ accountInfo.get(problem.entry.accountId)?.name ?? 'Konto' }}: {{ problem.text }}</span
        >
        <button type="button" class="link" :disabled="loading" @click="search()">
          Erneut versuchen
        </button>
      </li>
    </ul>

    <p v-if="error" class="message error">{{ error }}</p>
    <p v-else-if="!loading && query && messages.length === 0" class="hint">Keine Treffer.</p>

    <ul class="messages">
      <li v-for="message in messages" :key="`${message.folderId}:${message.uid}`">
        <button
          type="button"
          class="item"
          :class="{ unread: !message.flags.seen, remote: !message.synced }"
          :disabled="!message.id"
          :title="
            message.id ? undefined : 'Noch nicht synchronisiert – erscheint nach dem Abgleich'
          "
          @click="open(message)"
        >
          <span
            class="avatar"
            :style="{ background: accountInfo.get(message.accountId)?.color }"
            :title="accountInfo.get(message.accountId)?.name"
            >{{ accountInfo.get(message.accountId)?.initials ?? '?' }}</span
          >
          <span class="body">
            <span class="row">
              <span class="from">{{ personLabel(message.from) }}</span>
              <span class="date">{{ shortDate(message.date) }}</span>
            </span>
            <span class="row">
              <span class="subject"
                ><template
                  v-for="(part, index) in highlightParts(
                    message.subject || '(kein Betreff)',
                    terms,
                  )"
                  :key="index"
                  ><mark v-if="part.match">{{ part.text }}</mark
                  ><template v-else>{{ part.text }}</template></template
                ></span
              >
              <span class="folder">{{
                folderNames.get(message.accountId)?.get(message.folderId) ?? ''
              }}</span>
            </span>
            <span v-if="message.snippet" class="snippet">{{ message.snippet }}</span>
            <span v-else-if="!message.synced" class="snippet">Noch nicht synchronisiert</span>
          </span>
        </button>
      </li>
    </ul>
    <div v-if="nextCursor" ref="sentinel" class="more">
      <button type="button" class="secondary" :disabled="loading" @click="more()">
        {{ loading ? 'Lädt …' : 'Weitere Treffer laden' }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.global-search {
  max-width: 60rem;
  margin: 0 auto;
  background: var(--color-base-100);
  border-radius: 8px;
}

.header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--fma-space-2);
  padding: 0.6rem var(--fma-space-4);
  border-bottom: 1px solid var(--color-base-200);
}

.header h2 {
  margin: 0;
  font-size: var(--fma-text-lg);
}

.scope {
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  gap: var(--fma-space-3);
  margin: 0;
  padding: 0;
  border: none;
  font-size: 0.85rem;
}

.scope label {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
}

.summary {
  min-height: 1.2em;
  margin: 0;
  padding: 0.4rem var(--fma-space-4);
  font-size: var(--fma-text-xs);
  color: var(--fma-muted);
}

.problems {
  list-style: none;
  margin: 0;
  padding: 0;
}

.problems li {
  display: flex;
  justify-content: space-between;
  gap: var(--fma-space-2);
}

.messages {
  list-style: none;
  margin: 0;
  padding: 0;
}

.messages li {
  /* Rows off screen are not laid out: thousands of hits stay smooth. */
  content-visibility: auto;
  contain-intrinsic-size: auto 4.2rem;
}

.item {
  display: flex;
  gap: var(--fma-space-3);
  align-items: flex-start;
  width: 100%;
  padding: 0.6rem var(--fma-space-4);
  border: none;
  border-bottom: 1px solid var(--color-base-200);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.item:hover:not(:disabled) {
  background: var(--color-base-200);
}

.item.remote {
  cursor: default;
  opacity: 0.75;
}

.avatar {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  border-radius: 999px;
  /* Background: the account color (accountColor), white text is AA on all. */
  color: #fff;
  font-size: 0.75rem;
  font-weight: 600;
}

.body {
  flex: 1;
  min-width: 0;
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

.subject {
  font-size: 0.875rem;
}

.subject mark {
  background: color-mix(in srgb, var(--color-warning) 45%, transparent);
  color: inherit;
  border-radius: 2px;
}

.item.unread .from,
.item.unread .subject {
  font-weight: 600;
}

.date,
.folder {
  flex-shrink: 0;
  font-size: var(--fma-text-xs);
  color: var(--fma-muted);
}

.folder {
  max-width: 10rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.snippet {
  display: block;
  font-size: 0.8rem;
  color: var(--fma-muted);
}

.hint,
.message {
  padding: 0 var(--fma-space-4);
}

.more {
  padding: 0.8rem;
  text-align: center;
}
</style>
