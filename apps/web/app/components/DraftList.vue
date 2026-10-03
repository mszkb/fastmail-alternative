<script setup lang="ts">
// Saved drafts of the current account (roadmap 2.8): GET
// /api/accounts/:id/drafts, shown at the top of the Drafts folder (or in
// the sidebar when the account has no Drafts folder). Clicking a draft
// continues it in the compose form; × deletes it. Offline-first: the list
// is cached in the encrypted offline store, and draft saves/deletes still
// waiting in the offline queue are overlaid (overlayPendingDrafts from
// @fma/shared), so drafts written offline show up - also after a reload.
// `messageIds` (exposed) are the synced IMAP copies of these drafts; the
// Drafts folder list hides them so a draft is shown once.
import { overlayPendingDrafts, type Draft, type DraftListResponse } from '@fma/shared'
import { cacheGet, cachePut } from '~/utils/offline-store'
import { enqueueDraft, isNetworkError, offlineState } from '~/utils/offline-queue'

const props = defineProps<{ accountId: string }>()
const emit = defineEmits<{ open: [draft: Draft] }>()

const loaded = ref<Draft[]>([])
const error = ref('')
let loadRequest = 0

const drafts = computed(() =>
  overlayPendingDrafts(loaded.value, props.accountId, offlineState.queue),
)
const messageIds = computed(() => new Set(drafts.value.flatMap((d) => d.messageIds)))

const dateFormat = new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'short' })

function cacheKey(account: string): string {
  return `drafts:${account}`
}

async function reload(): Promise<void> {
  const account = props.accountId
  if (!account) return
  const request = ++loadRequest
  const cached = await cacheGet<Draft[]>(cacheKey(account))
  if (cached && request === loadRequest && loaded.value.length === 0) loaded.value = cached
  try {
    const res = await fetch(`/api/accounts/${account}/drafts`)
    if (!res.ok) throw new Error(`Fehler ${res.status}`)
    const body = (await res.json()) as DraftListResponse
    if (request !== loadRequest) return
    loaded.value = body.drafts
    error.value = ''
    void cachePut(cacheKey(account), body.drafts, { accountId: account, pinned: true })
  } catch (err) {
    if (request === loadRequest && !isNetworkError(err) && !cached) {
      error.value = 'Entwürfe konnten nicht geladen werden.'
    }
  }
}

async function remove(draft: Draft): Promise<void> {
  if (!window.confirm('Entwurf verwerfen? Der Text geht verloren.')) return
  const account = props.accountId
  loaded.value = loaded.value.filter((d) => d.id !== draft.id)
  void cachePut(cacheKey(account), toRaw(loaded.value), { accountId: account, pinned: true })
  try {
    if (navigator.onLine === false || offlineState.queue.length > 0) {
      await enqueueDraft(account, draft.id, null)
      return
    }
    const res = await fetch(`/api/drafts/${draft.id}`, { method: 'DELETE' })
    if (!res.ok) throw new Error(`Fehler ${res.status}`)
  } catch (err) {
    if (isNetworkError(err)) await enqueueDraft(account, draft.id, null)
    else error.value = 'Der Entwurf konnte nicht gelöscht werden.'
  }
}

function recipients(draft: Draft): string {
  return draft.to.trim() || '(kein Empfänger)'
}

watch(
  () => props.accountId,
  () => {
    loaded.value = []
    void reload()
  },
  { immediate: true },
)
watch(
  () => offlineState.replayedAt,
  () => void reload(),
)

defineExpose({ reload, messageIds })
</script>

<template>
  <section v-if="drafts.length > 0 || error" class="drafts" aria-label="Gespeicherte Entwürfe">
    <h3>Entwürfe</h3>
    <p v-if="error" class="error">{{ error }}</p>
    <ul>
      <li v-for="draft in drafts" :key="draft.id">
        <button type="button" class="draft" @click="emit('open', draft)">
          <span class="row">
            <span class="to">{{ recipients(draft) }}</span>
            <span class="date">{{ dateFormat.format(new Date(draft.updatedAt)) }}</span>
          </span>
          <span class="subject">{{ draft.subject || '(kein Betreff)' }}</span>
        </button>
        <button
          type="button"
          class="remove"
          title="Entwurf verwerfen"
          aria-label="Entwurf verwerfen"
          @click="remove(draft)"
        >
          &times;
        </button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.drafts {
  border-bottom: 1px solid #e4e9ee;
  background: #fffdf5;
}

h3 {
  margin: 0;
  padding: 0.5rem 0.75rem 0.25rem;
  font-size: 0.8rem;
  font-weight: 600;
  color: #8a6d1d;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

ul {
  margin: 0;
  padding: 0;
  list-style: none;
}

li {
  display: flex;
  align-items: stretch;
  border-top: 1px solid #f3ead0;
}

.draft {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 0.15rem;
  padding: 0.5rem 0.75rem;
  border: none;
  background: transparent;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.draft:hover {
  background: #fff6db;
}

.row {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
}

.to,
.subject {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.to {
  font-weight: 600;
}

.date {
  flex: none;
  font-size: 0.8rem;
  color: #52606d;
}

.subject {
  font-size: 0.9rem;
  color: #323f4b;
}

.remove {
  flex: none;
  width: 2.25rem;
  border: none;
  background: transparent;
  color: #9b1c1c;
  font-size: 1.2rem;
  cursor: pointer;
}

.error {
  margin: 0 0.75rem 0.5rem;
  font-size: 0.85rem;
  color: #9b1c1c;
}
</style>
