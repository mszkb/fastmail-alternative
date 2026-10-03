<script setup lang="ts">
// Compose form (roadmap 2.6): new message, reply, reply all, forward. The
// prefill (recipients, subject, quote, signature, threading headers) comes
// from createDraft in @fma/shared; this component only edits and submits
// it to POST /api/outbox. Sending itself happens in the worker - the
// outbox panel in MailView shows the status. Plain text only.
// Offline (4.6): every form gets a clientId (idempotency key of the
// outbox). Without a connection the message goes to the offline queue and
// is submitted with the same clientId later - it is never sent twice.
import {
  OUTBOX_LIMITS,
  formatAddressList,
  parseAddressList,
  type ComposeDraft,
  type ComposeIdentity,
  type MailPerson,
  type OutboxMessage,
  type SendMessageRequest,
} from '@fma/shared'
import { addNotice, enqueueSend, isNetworkError, newId } from '~/utils/offline-queue'

const props = defineProps<{
  accountId: string
  identities: ComposeIdentity[]
  draft: ComposeDraft
}>()
const emit = defineEmits<{ close: []; queued: [message: OutboxMessage] }>()

const TITLES: Record<ComposeDraft['mode'], string> = {
  new: 'Neue E-Mail',
  reply: 'Antworten',
  replyAll: 'Allen antworten',
  forward: 'Weiterleiten',
}

const initial = {
  identityId: props.draft.identityId ?? props.identities[0]?.id ?? '',
  to: formatAddressList(props.draft.to),
  cc: formatAddressList(props.draft.cc),
  bcc: formatAddressList(props.draft.bcc),
  subject: props.draft.subject,
  text: props.draft.text,
}
const form = reactive({ ...initial })
const showCcBcc = ref(Boolean(initial.cc || initial.bcc))
const sending = ref(false)
const error = ref('')
const toInput = ref<HTMLInputElement | null>(null)
const clientId = newId()
const textInput = ref<HTMLTextAreaElement | null>(null)

const dirty = computed(() =>
  (Object.keys(initial) as (keyof typeof initial)[]).some((key) => form[key] !== initial[key]),
)

function parseField(label: string, value: string): MailPerson[] | null {
  const { people, invalid } = parseAddressList(value)
  if (invalid.length > 0) {
    error.value = `${label}: ungültige Adresse „${invalid[0]}“.`
    return null
  }
  return people
}

function discard(): void {
  if (sending.value) return
  if (dirty.value && !window.confirm('Nachricht verwerfen? Die Änderungen gehen verloren.')) return
  emit('close')
}

async function send(): Promise<void> {
  if (sending.value) return
  error.value = ''
  const to = parseField('An', form.to)
  const cc = to && parseField('Cc', form.cc)
  const bcc = cc && parseField('Bcc', form.bcc)
  if (!to || !cc || !bcc) return
  const total = to.length + cc.length + bcc.length
  if (total === 0) {
    error.value = 'Bitte mindestens einen Empfänger angeben.'
    return
  }
  if (total > OUTBOX_LIMITS.maxRecipients) {
    error.value = `Höchstens ${OUTBOX_LIMITS.maxRecipients} Empfänger sind erlaubt.`
    return
  }
  if (form.subject.length > OUTBOX_LIMITS.maxSubjectLength) {
    error.value = 'Der Betreff ist zu lang.'
    return
  }
  if (form.text.length > OUTBOX_LIMITS.maxTextLength) {
    error.value = 'Der Nachrichtentext ist zu lang.'
    return
  }
  if (!form.subject.trim() && !window.confirm('Ohne Betreff senden?')) return

  const body: SendMessageRequest & { clientId: string } = {
    accountId: props.accountId,
    to,
    cc,
    bcc,
    subject: form.subject,
    text: form.text,
    clientId,
  }
  if (form.identityId) body.identityId = form.identityId
  if (props.draft.inReplyTo) body.inReplyTo = props.draft.inReplyTo
  if (props.draft.references?.length) body.references = props.draft.references

  sending.value = true
  if (navigator.onLine === false) {
    await queueOffline(body)
    return
  }
  try {
    const res = await fetch('/api/outbox', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const payload = (await res.json().catch(() => null)) as
      (OutboxMessage & { message?: string }) | null
    if (!res.ok || !payload) {
      error.value = payload?.message ?? `Senden fehlgeschlagen (Fehler ${res.status}).`
      return
    }
    emit('queued', payload)
    emit('close')
  } catch (err) {
    if (isNetworkError(err)) {
      await queueOffline(body)
      return
    }
    error.value = 'API nicht erreichbar - die Nachricht wurde nicht gesendet.'
  } finally {
    sending.value = false
  }
}

/** No connection: queue the message; it is submitted once online again. */
async function queueOffline(body: SendMessageRequest & { clientId: string }): Promise<void> {
  try {
    await enqueueSend(body)
    addNotice('Keine Verbindung: Die Nachricht wird gesendet, sobald die App wieder online ist.')
    emit('close')
  } finally {
    sending.value = false
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    discard()
  } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault()
    void send()
  }
}

onMounted(() => {
  // New mail and forwards start with the recipients, replies with the text.
  if (props.draft.mode === 'new' || props.draft.mode === 'forward') {
    toInput.value?.focus()
  } else if (textInput.value) {
    textInput.value.focus()
    textInput.value.setSelectionRange(0, 0)
    textInput.value.scrollTop = 0
  }
})
</script>

<template>
  <div class="compose-backdrop" @keydown="onKeydown">
    <form
      class="compose"
      role="dialog"
      aria-modal="true"
      :aria-label="TITLES[draft.mode]"
      @submit.prevent="send"
    >
      <header class="compose-header">
        <h2>{{ TITLES[draft.mode] }}</h2>
        <button type="button" class="icon" title="Verwerfen (Esc)" @click="discard">&times;</button>
      </header>

      <div class="fields">
        <label class="field">
          <span>Von</span>
          <select v-model="form.identityId" :disabled="identities.length <= 1">
            <option v-for="identity in identities" :key="identity.id" :value="identity.id">
              {{
                identity.name
                  ? `${identity.name} <${identity.emailAddress}>`
                  : identity.emailAddress
              }}
            </option>
          </select>
        </label>
        <label class="field">
          <span>An</span>
          <input
            ref="toInput"
            v-model="form.to"
            type="text"
            inputmode="email"
            autocomplete="off"
            placeholder="name@example.com, Name <name@example.com>"
          />
          <button
            v-if="!showCcBcc"
            type="button"
            class="link"
            title="Cc/Bcc hinzufügen"
            @click="showCcBcc = true"
          >
            Cc/Bcc
          </button>
        </label>
        <template v-if="showCcBcc">
          <label class="field">
            <span>Cc</span>
            <input v-model="form.cc" type="text" inputmode="email" autocomplete="off" />
          </label>
          <label class="field">
            <span>Bcc</span>
            <input v-model="form.bcc" type="text" inputmode="email" autocomplete="off" />
          </label>
        </template>
        <label class="field">
          <span>Betreff</span>
          <input v-model="form.subject" type="text" :maxlength="OUTBOX_LIMITS.maxSubjectLength" />
        </label>
      </div>

      <label class="body">
        <span class="visually-hidden">Nachricht</span>
        <textarea ref="textInput" v-model="form.text" spellcheck="true" />
      </label>

      <footer class="compose-footer">
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <div class="buttons">
          <button type="button" class="secondary" :disabled="sending" @click="discard">
            Verwerfen
          </button>
          <button type="submit" class="primary" :disabled="sending" title="Strg+Enter">
            {{ sending ? 'Wird gesendet …' : 'Senden' }}
          </button>
        </div>
      </footer>
    </form>
  </div>
</template>

<style scoped>
.compose-backdrop {
  position: fixed;
  inset: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1.5rem;
  background: rgb(15 23 42 / 0.35);
}

.compose {
  display: flex;
  flex-direction: column;
  width: min(48rem, 100%);
  height: min(44rem, 100%);
  border-radius: 0.5rem;
  background: #fff;
  box-shadow: 0 10px 40px rgb(15 23 42 / 0.25);
  overflow: hidden;
}

.compose-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.6rem 1rem;
  border-bottom: 1px solid #e4e9ee;
  background: #f7f9fb;
}

h2 {
  margin: 0;
  font-size: 1.05rem;
}

button.icon {
  border: none;
  background: transparent;
  color: #52606d;
  font-size: 1.5rem;
  line-height: 1;
  cursor: pointer;
}

.fields {
  padding: 0.25rem 1rem;
  border-bottom: 1px solid #e4e9ee;
}

.field {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.3rem 0;
  border-bottom: 1px solid #eef2f6;
}

.field:last-child {
  border-bottom: none;
}

.field > span {
  flex: 0 0 4rem;
  font-size: 0.85rem;
  color: #52606d;
}

.field input,
.field select {
  flex: 1;
  min-width: 0;
  padding: 0.35rem 0.4rem;
  border: 1px solid transparent;
  border-radius: 0.375rem;
  background: transparent;
  font: inherit;
}

.field input:focus,
.field select:focus {
  border-color: #b8c2cc;
  outline: none;
}

button.link {
  border: none;
  background: transparent;
  color: #1273de;
  font: inherit;
  font-size: 0.85rem;
  cursor: pointer;
}

.body {
  display: flex;
  flex: 1;
  min-height: 0;
}

textarea {
  flex: 1;
  padding: 0.75rem 1rem;
  border: none;
  resize: none;
  font-family: inherit;
  font-size: 0.95rem;
  line-height: 1.5;
}

textarea:focus {
  outline: none;
}

.compose-footer {
  padding: 0.6rem 1rem;
  border-top: 1px solid #e4e9ee;
}

.buttons {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}

button.primary,
button.secondary {
  padding: 0.45rem 1rem;
  border: 1px solid #1273de;
  border-radius: 0.375rem;
  font: inherit;
  cursor: pointer;
}

button.primary {
  background: #1273de;
  color: #fff;
}

button.secondary {
  background: transparent;
  color: #1273de;
}

button:disabled {
  opacity: 0.6;
  cursor: default;
}

.error {
  margin: 0 0 0.5rem;
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

/* Mobile: full-screen compose. */
@media (max-width: 760px) {
  .compose-backdrop {
    padding: 0;
  }

  .compose {
    width: 100%;
    height: 100%;
    border-radius: 0;
  }

  .compose-footer {
    padding-bottom: calc(0.6rem + env(safe-area-inset-bottom));
  }

  /* 16px avoids the automatic zoom on focus in iOS Safari. */
  .field input,
  .field select,
  textarea {
    font-size: 16px;
  }
}
</style>
