<script setup lang="ts">
// Optional unified inbox (roadmap 3.7, opt-in in the settings): the INBOX
// messages of all accounts in one list (GET /api/unified/inbox), each with
// an account tag. Opening a message hands it to the mail view of its own
// account (emit `open`), so reading, actions and replies always use the
// account the message belongs to. Online only: the list is not cached
// offline; without a connection a hint is shown instead.
import type {
  AccountSummary,
  MailPerson,
  UnifiedMessageListItem,
  UnifiedMessageListResponse,
} from '@fma/shared'
import { isOffline } from '~/utils/offline-queue'

const props = defineProps<{
  accounts: Pick<AccountSummary, 'id' | 'displayName' | 'emailAddress'>[]
}>()
const emit = defineEmits<{ open: [accountId: string, messageId: string]; back: [] }>()

const messages = ref<UnifiedMessageListItem[]>([])
const nextCursor = ref<string | null>(null)
const loading = ref(false)
const error = ref('')
let request = 0

/** Fixed palette; an account keeps its color by its position in the list. */
const TAG_COLORS = ['#1273de', '#0e7c66', '#b44d12', '#7b3fbf', '#a3165a', '#4b5563']

const accountTags = computed(() => {
  const tags = new Map<string, { label: string; color: string; title: string }>()
  props.accounts.forEach((account, index) => {
    tags.set(account.id, {
      label: account.displayName,
      color: TAG_COLORS[index % TAG_COLORS.length]!,
      title: account.emailAddress,
    })
  })
  return tags
})

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

async function load(more = false): Promise<void> {
  const current = ++request
  const cursor = more ? nextCursor.value : null
  loading.value = true
  error.value = ''
  try {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
    const res = await fetch(`/api/unified/inbox${query}`)
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { message?: string } | null
      throw new Error(body?.message ?? `Fehler ${res.status}`)
    }
    const body = (await res.json()) as UnifiedMessageListResponse
    if (current !== request) return
    messages.value = cursor ? [...messages.value, ...body.messages] : body.messages
    nextCursor.value = body.nextCursor
  } catch (err) {
    if (current !== request) return
    error.value = isOffline.value
      ? 'Der gemeinsame Posteingang ist nur online verfügbar.'
      : err instanceof Error
        ? err.message
        : 'Nachrichten konnten nicht geladen werden.'
  } finally {
    if (current === request) loading.value = false
  }
}

defineExpose({ reload: () => load() })

onMounted(() => void load())
</script>

<template>
  <section class="unified" aria-label="Alle Posteingänge">
    <header class="header">
      <button type="button" class="secondary" @click="emit('back')">&larr; Konten</button>
      <h2>Alle Posteingänge</h2>
      <button type="button" class="secondary" :disabled="loading" @click="load()">
        Aktualisieren
      </button>
    </header>
    <p v-if="error" class="message error">{{ error }}</p>
    <p v-else-if="!loading && messages.length === 0" class="hint">Keine Nachrichten.</p>
    <ul class="messages">
      <li v-for="message in messages" :key="`${message.accountId}:${message.id}`">
        <button
          type="button"
          class="item"
          :class="{ unread: !message.flags.seen }"
          @click="emit('open', message.accountId, message.id)"
        >
          <span class="row">
            <span class="from">{{ personLabel(message.from) }}</span>
            <span class="date">{{ shortDate(message.date) }}</span>
          </span>
          <span class="row">
            <span class="subject">{{ message.subject || '(kein Betreff)' }}</span>
            <span
              class="account-tag"
              :style="{ background: accountTags.get(message.accountId)?.color }"
              :title="accountTags.get(message.accountId)?.title"
              >{{ accountTags.get(message.accountId)?.label ?? 'Konto' }}</span
            >
          </span>
          <span class="snippet">{{ message.snippet }}</span>
        </button>
      </li>
    </ul>
    <div v-if="nextCursor" class="more">
      <button type="button" class="secondary" :disabled="loading" @click="load(true)">
        Mehr laden
      </button>
    </div>
  </section>
</template>

<style scoped>
.unified {
  max-width: 60rem;
  margin: 0 auto;
  background: #fff;
  border-radius: 8px;
}

.header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.6rem 1rem;
  border-bottom: 1px solid #eef2f6;
}

.header h2 {
  flex: 1;
  margin: 0;
  font-size: 1.1rem;
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

.subject {
  font-size: 0.875rem;
}

.item.unread .from,
.item.unread .subject {
  font-weight: 600;
}

.date {
  flex-shrink: 0;
  font-size: 0.75rem;
  color: #52606d;
}

.account-tag {
  flex-shrink: 0;
  max-width: 10rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 0 0.4rem;
  border-radius: 999px;
  color: #fff;
  font-size: 0.7rem;
  line-height: 1.4;
}

.snippet {
  display: block;
  font-size: 0.8rem;
  color: #52606d;
}

.hint,
.message {
  padding: 0 1rem;
}

.more {
  padding: 0.8rem;
  text-align: center;
}
</style>
