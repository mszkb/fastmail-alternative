<script setup lang="ts">
// Outbox indicator (roadmap 2.6): pending and failed messages of the
// current account (GET /api/accounts/:id/outbox) plus messages sent from
// this tab, polled while something is still on its way. Failed messages
// show the German error text from @fma/shared and can be retried.
// Offline (4.6): queued sends are counted in the app's pending indicator;
// after a replay the list is reloaded. No error while offline.
import type { OutboxListResponse, OutboxMessage, OutboxStatus } from '@fma/shared'
import { isNetworkError, offlineState } from '~/utils/offline-queue'

const props = defineProps<{ accountId: string }>()

const POLL_MS = 3000
const STATUS_LABELS: Record<OutboxStatus, string> = {
  queued: 'Wartet',
  sending: 'Wird gesendet',
  sent: 'Gesendet',
  failed: 'Fehlgeschlagen',
}

const entries = ref<OutboxMessage[]>([])
const open = ref(false)
const error = ref('')
const retrying = ref<Set<string>>(new Set())
let timer: ReturnType<typeof setTimeout> | null = null
let loadRequest = 0

const pending = computed(
  () => entries.value.filter((m) => m.status === 'queued' || m.status === 'sending').length,
)
const failed = computed(() => entries.value.filter((m) => m.status === 'failed').length)
const summary = computed(() => {
  const parts: string[] = []
  if (pending.value) parts.push(`${pending.value} wird gesendet`)
  if (failed.value) parts.push(`${failed.value} fehlgeschlagen`)
  if (parts.length === 0) parts.push('gesendet')
  return parts.join(', ')
})

function recipients(message: OutboxMessage): string {
  const people = [...message.to, ...message.cc, ...message.bcc]
  if (people.length === 0) return ''
  const first = people[0]!
  const label = first.name || first.address
  return people.length > 1 ? `${label} +${people.length - 1}` : label
}

function upsert(message: OutboxMessage): void {
  const index = entries.value.findIndex((m) => m.id === message.id)
  if (index >= 0) entries.value.splice(index, 1, message)
  else entries.value.unshift(message)
}

function schedule(): void {
  if (timer) clearTimeout(timer)
  timer = null
  if (pending.value > 0) timer = setTimeout(() => void refresh(), POLL_MS)
}

/** Reloads the server list; messages that left it are re-read individually (sent). */
async function refresh(): Promise<void> {
  if (!props.accountId) return
  const request = ++loadRequest
  const account = props.accountId
  try {
    const res = await fetch(`/api/accounts/${account}/outbox`)
    if (!res.ok) throw new Error(`Fehler ${res.status}`)
    const body = (await res.json()) as OutboxListResponse
    if (request !== loadRequest || account !== props.accountId) return
    const listed = new Set(body.messages.map((m) => m.id))
    // Messages known here but no longer listed have been sent: fetch their
    // final status once (subject etc. may already be cleared).
    const gone = entries.value.filter((m) => !listed.has(m.id) && m.status !== 'sent')
    const finals = await Promise.all(
      gone.map(async (m) => {
        const single = await fetch(`/api/outbox/${m.id}`).catch(() => null)
        if (!single?.ok) return null
        const final = (await single.json()) as OutboxMessage
        // Keep the subject/recipients known from before.
        return {
          ...final,
          subject: final.subject ?? m.subject,
          to: final.to.length ? final.to : m.to,
        }
      }),
    )
    if (request !== loadRequest || account !== props.accountId) return
    const sent = entries.value.filter((m) => !listed.has(m.id) && m.status === 'sent')
    entries.value = [
      ...body.messages,
      ...finals.filter((m): m is OutboxMessage => m !== null),
      ...sent,
    ].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    error.value = ''
  } catch (err) {
    if (request === loadRequest && !isNetworkError(err)) {
      error.value = 'Postausgang konnte nicht geladen werden.'
    }
  } finally {
    if (request === loadRequest) schedule()
  }
}

/** Called after a message was submitted from the compose form. */
function track(message: OutboxMessage): void {
  if (message.accountId !== props.accountId) return
  upsert(message)
  schedule()
}

async function retry(message: OutboxMessage): Promise<void> {
  if (retrying.value.has(message.id)) return
  retrying.value.add(message.id)
  error.value = ''
  try {
    const res = await fetch(`/api/outbox/${message.id}/retry`, { method: 'POST' })
    const body = (await res.json().catch(() => null)) as
      (OutboxMessage & { message?: string }) | null
    if (!res.ok || !body) {
      error.value = body?.message ?? `Erneutes Senden fehlgeschlagen (Fehler ${res.status}).`
      return
    }
    upsert({ ...body, subject: body.subject ?? message.subject })
    schedule()
  } catch {
    error.value = 'API nicht erreichbar.'
  } finally {
    retrying.value.delete(message.id)
  }
}

function dismissSent(): void {
  entries.value = entries.value.filter((m) => m.status !== 'sent')
  if (entries.value.length === 0) open.value = false
}

function onFocus(): void {
  void refresh()
}

watch(
  () => props.accountId,
  () => {
    entries.value = []
    open.value = false
    void refresh()
  },
  { immediate: true },
)

// Queued sends were submitted (back online): show them.
watch(
  () => offlineState.replayedAt,
  () => void refresh(),
)

onMounted(() => window.addEventListener('focus', onFocus))
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
  window.removeEventListener('focus', onFocus)
})

defineExpose({ track, refresh })
</script>

<template>
  <div v-if="entries.length > 0 || error" class="outbox">
    <button
      type="button"
      class="toggle"
      :class="{ failed: failed > 0 }"
      :aria-expanded="open"
      @click="open = !open"
    >
      <span>Postausgang</span>
      <span class="summary">{{ summary }}</span>
    </button>
    <p v-if="error" class="error">{{ error }}</p>
    <ul v-if="open" class="entries">
      <li v-for="message in entries" :key="message.id" :class="`status-${message.status}`">
        <span class="line">
          <span class="subject">{{ message.subject || '(kein Betreff)' }}</span>
          <span class="status">{{ STATUS_LABELS[message.status] }}</span>
        </span>
        <span v-if="recipients(message)" class="to">An {{ recipients(message) }}</span>
        <span v-if="message.error" class="error-text">{{ message.error.message }}</span>
        <button
          v-if="message.status === 'failed'"
          type="button"
          class="retry"
          :disabled="retrying.has(message.id)"
          @click="retry(message)"
        >
          Erneut senden
        </button>
      </li>
      <li v-if="entries.some((m) => m.status === 'sent')" class="clear">
        <button type="button" class="link" @click="dismissSent">Gesendete ausblenden</button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.outbox {
  margin-top: 0.75rem;
  border-top: 1px solid #e4e9ee;
  padding-top: 0.5rem;
  font-size: 0.85rem;
}

.toggle {
  display: flex;
  flex-direction: column;
  width: 100%;
  padding: 0.4rem 0.6rem;
  border: none;
  border-radius: 0.375rem;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.toggle:hover {
  background: #e4e9ee;
}

.summary {
  font-size: 0.75rem;
  color: #52606d;
}

.toggle.failed .summary {
  color: #9b1c1c;
}

.entries {
  list-style: none;
  margin: 0.25rem 0 0;
  padding: 0;
}

.entries li {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  padding: 0.4rem 0.6rem;
  border-bottom: 1px solid #eef2f6;
}

.line {
  display: flex;
  justify-content: space-between;
  gap: 0.4rem;
}

.subject,
.to {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status {
  flex-shrink: 0;
  font-size: 0.75rem;
  color: #52606d;
}

.status-sent .status {
  color: #18794e;
}

.status-failed .status,
.error-text,
.error {
  color: #9b1c1c;
}

.to,
.error-text {
  font-size: 0.75rem;
}

.error {
  margin: 0.25rem 0.6rem;
  font-size: 0.75rem;
}

.retry {
  align-self: flex-start;
  padding: 0.2rem 0.6rem;
  border: 1px solid #1273de;
  border-radius: 0.375rem;
  background: transparent;
  color: #1273de;
  font: inherit;
  font-size: 0.8rem;
  cursor: pointer;
}

.clear {
  border-bottom: none !important;
}

button.link {
  align-self: flex-start;
  padding: 0;
  border: none;
  background: transparent;
  color: #1273de;
  font: inherit;
  font-size: 0.75rem;
  cursor: pointer;
}
</style>
