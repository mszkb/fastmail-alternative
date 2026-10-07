<script setup lang="ts">
// Compose form (roadmap 2.6): new message, reply, reply all, forward. The
// prefill (recipients, subject, quote, signature, threading headers) comes
// from createDraft in @fma/shared; this component only edits and submits
// it to POST /api/outbox. Sending itself happens in the worker - the
// outbox panel in MailView shows the status. Plain text only.
// Offline (4.6): every form gets a clientId (idempotency key of the
// outbox). Without a connection the message goes to the offline queue and
// is submitted with the same clientId later - it is never sent twice.
// Drafts (2.8): changes are autosaved (debounced) to PUT /api/drafts/:id
// with a client-generated draft id, so a draft survives a reload and a
// device change; offline the save goes to the (encrypted) offline queue.
// A save based on an outdated version (edited on another device meanwhile)
// shows a conflict notice: load the other version or keep this one (last
// write wins). Closing keeps the draft, "Verwerfen" deletes it, sending
// deletes it on the server (draftId in the outbox request).
// Composer like elsewhere (#116): in the reading pane on wide screens
// (`inPane`), full screen on phones; recipient suggestions from addresses
// the app already knows; attachments by drag and drop; Ctrl/Cmd+Enter
// sends; an undo-send window (settings, per device) delays the submit to
// the outbox - "Rückgängig" returns to editing, nothing reached the server.
import {
  applyRecipientSuggestion,
  suggestRecipients,
  OUTBOX_LIMITS,
  formatAddressList,
  parseAddressList,
  type ComposeDraft,
  type ComposeIdentity,
  type Draft,
  type DraftConflictResponse,
  type MailPerson,
  type OutboxMessage,
  type SaveDraftRequest,
  type SendMessageRequest,
  type UploadedAttachment,
  type CopyAttachmentsResponse,
  type AttachmentMissingResponse,
  ATTACHMENT_LIMIT_DEFAULTS,
  ATTACHMENT_MISSING,
  formatByteSize,
} from '@fma/shared'
import {
  addNotice,
  enqueueDraft,
  enqueueSend,
  isNetworkError,
  newId,
  offlineState,
} from '~/utils/offline-queue'
import { undoSendSeconds } from '~/utils/undo-send'

const props = defineProps<{
  accountId: string
  identities: ComposeIdentity[]
  draft: ComposeDraft
  /** Saved draft to continue (roadmap 2.8); its fields replace the prefill. */
  saved?: Draft
  /** Forward: id of the forwarded message, whose attachments are taken over (5.3). */
  forwardOf?: string
  /** Addresses for the recipient suggestions (#116). */
  knownPeople?: MailPerson[]
  /** Shown in the reading pane instead of as an overlay (wide screens). */
  inPane?: boolean
  /** Shown below the conversation (a reply in the reading pane). */
  inline?: boolean
}>()
const emit = defineEmits<{
  close: []
  queued: [message: OutboxMessage]
  /** A draft was saved or deleted (the drafts list reloads). */
  draftsChanged: []
}>()

const TITLES: Record<ComposeDraft['mode'], string> = {
  new: 'Neue E-Mail',
  reply: 'Antworten',
  replyAll: 'Allen antworten',
  forward: 'Weiterleiten',
}
/** Autosave delay after the last change. */
const AUTOSAVE_DELAY_MS = 2000

const saved = props.saved
const initial = {
  identityId: saved?.identityId ?? props.draft.identityId ?? props.identities[0]?.id ?? '',
  to: saved ? saved.to : formatAddressList(props.draft.to),
  cc: saved ? saved.cc : formatAddressList(props.draft.cc),
  bcc: saved ? saved.bcc : formatAddressList(props.draft.bcc),
  subject: saved ? saved.subject : props.draft.subject,
  text: saved ? saved.text : props.draft.text,
}
const inReplyTo = saved ? saved.inReplyTo : (props.draft.inReplyTo ?? null)
const references = saved ? saved.references : (props.draft.references ?? [])
const form = reactive({ ...initial })
const showCcBcc = ref(Boolean(initial.cc || initial.bcc))
const sending = ref(false)
const error = ref('')
const toInput = ref<HTMLInputElement | null>(null)
const clientId = newId()
const textInput = ref<HTMLTextAreaElement | null>(null)

// Recipient suggestions (#116) for the focused field (An/Cc/Bcc).
type RecipientField = 'to' | 'cc' | 'bcc'
const activeField = ref<RecipientField | ''>('')
const highlighted = ref(0)
const suggestions = computed(() =>
  activeField.value && props.knownPeople?.length
    ? suggestRecipients(form[activeField.value], props.knownPeople)
    : [],
)
watch(suggestions, () => (highlighted.value = 0))

function choose(index: number): void {
  const field = activeField.value
  const person = suggestions.value[index]
  if (!field || !person) return
  form[field] = applyRecipientSuggestion(form[field], person)
}

function onRecipientKeydown(event: KeyboardEvent): void {
  const count = suggestions.value.length
  if (count === 0) return
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    highlighted.value = (highlighted.value + (event.key === 'ArrowDown' ? 1 : count - 1)) % count
  } else if ((event.key === 'Enter' && !event.ctrlKey && !event.metaKey) || event.key === 'Tab') {
    if (event.key === 'Enter' || !event.shiftKey) {
      event.preventDefault()
      choose(highlighted.value)
    }
  } else if (event.key === 'Escape') {
    // Closes the list only, not the form.
    event.preventDefault()
    activeField.value = ''
  }
}

function onRecipientBlur(): void {
  // Let a click on a suggestion land first.
  setTimeout(() => (activeField.value = ''), 150)
}

// Undo send (#116): countdown before the submit; 0 = off.
const countdown = ref(0)
let countdownTimer: ReturnType<typeof setInterval> | undefined
let countdownDone: ((send: boolean) => void) | null = null

function waitForUndoWindow(seconds: number): Promise<boolean> {
  countdown.value = seconds
  return new Promise((resolve) => {
    countdownDone = resolve
    countdownTimer = setInterval(() => {
      countdown.value--
      if (countdown.value <= 0) finishCountdown(true)
    }, 1000)
  })
}

function finishCountdown(send: boolean): void {
  clearInterval(countdownTimer)
  countdown.value = 0
  countdownDone?.(send)
  countdownDone = null
}

function undoSend(): void {
  finishCountdown(false)
}

onBeforeUnmount(() => finishCountdown(false))

// Attachments (roadmap 5.3): uploaded right away (encrypted on the server),
// sent by id. Saved with the draft (attachmentIds), so they survive closing
// and reopening it; discarding the draft (or closing a never saved form)
// removes them on the server. Forwards take over the original's attachments.
const attachments = ref<UploadedAttachment[]>([...(props.saved?.attachments ?? [])])
const uploading = ref(0)
const fileInput = ref<HTMLInputElement | null>(null)

/** Uploads one file; waits and retries a few times while the server is busy (429). */
async function uploadFile(file: File): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`/api/accounts/${props.accountId}/uploads`, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-filename': encodeURIComponent(file.name),
        'x-content-type': file.type || 'application/octet-stream',
      },
      body: file,
    })
    if (res.status !== 429 || attempt >= 5) return res
    const seconds = Number(res.headers.get('retry-after')) || 2
    await new Promise((resolve) => setTimeout(resolve, Math.min(seconds, 10) * 1000))
  }
}

async function addFiles(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const files = [...(input.files ?? [])]
  input.value = ''
  await uploadFiles(files)
}

// Drag and drop of files onto the form (#116).
const dragging = ref(false)

function onDragOver(event: DragEvent): void {
  if (!event.dataTransfer?.types.includes('Files') || sending.value) return
  event.preventDefault()
  dragging.value = true
}

function onDrop(event: DragEvent): void {
  dragging.value = false
  const files = [...(event.dataTransfer?.files ?? [])]
  if (files.length === 0) return
  event.preventDefault()
  void uploadFiles(files)
}

async function uploadFiles(files: File[]): Promise<void> {
  error.value = ''
  for (const file of files) {
    if (attachments.value.length + uploading.value >= ATTACHMENT_LIMIT_DEFAULTS.maxCount) {
      error.value = `Höchstens ${ATTACHMENT_LIMIT_DEFAULTS.maxCount} Anhänge sind erlaubt.`
      break
    }
    uploading.value++
    try {
      const res = await uploadFile(file)
      const payload = (await res.json().catch(() => null)) as
        (UploadedAttachment & { message?: string }) | null
      if (!res.ok || !payload) {
        error.value = `${file.name}: ${payload?.message ?? `Hochladen fehlgeschlagen (Fehler ${res.status}).`}`
      } else {
        attachments.value.push(payload)
      }
    } catch {
      error.value = `${file.name}: Hochladen fehlgeschlagen (offline?).`
    } finally {
      uploading.value--
    }
  }
}

function removeAttachment(attachment: UploadedAttachment): void {
  attachments.value = attachments.value.filter((a) => a.id !== attachment.id)
  void fetch(`/api/uploads/${attachment.id}`, { method: 'DELETE' }).catch(() => {})
}

/** Form closed without sending: the uploads are not needed anymore (best effort). */
function dropAttachments(): void {
  for (const attachment of attachments.value) removeAttachment(attachment)
}

// Draft state: id (client-generated for new drafts), the server version
// this form is based on (0 = not saved yet) and the last saved content.
const draftId = saved?.id ?? newId()
const version = ref(saved?.version ?? 0)
const everSaved = ref(Boolean(saved))
const saveState = ref<'' | 'saving' | 'saved' | 'queued' | 'error'>(saved ? 'saved' : '')
const conflict = ref<Draft | null>(null)
/** Compared to detect unsaved changes: the form plus the attachment ids. */
function snapshotOf(): string {
  return JSON.stringify({ ...form, attachmentIds: attachments.value.map((a) => a.id) })
}
// A ref, so `dirty` (and the "saved" label) updates after a save.
const lastSaved = ref(snapshotOf())
let saveTimer: ReturnType<typeof setTimeout> | undefined
let saving: Promise<void> | null = null
// After send/discard (or once the draft is gone on the server): no more saves.
let finished = false
// Once a save went through the offline queue (saved with force), later
// direct saves must not report our own queued version as a conflict.
let forceSaves = false

const title = computed(() => (saved ? 'Entwurf' : TITLES[props.draft.mode]))
const dirty = computed(() => snapshotOf() !== lastSaved.value)
const saveLabel = computed(() => {
  switch (saveState.value) {
    case 'saving':
      return 'Wird gespeichert …'
    case 'saved':
      return dirty.value ? '' : 'Entwurf gespeichert'
    case 'queued':
      return 'Entwurf lokal gespeichert (offline)'
    case 'error':
      return conflict.value ? '' : 'Entwurf konnte nicht gespeichert werden'
    default:
      return ''
  }
})

function parseField(label: string, value: string): MailPerson[] | null {
  const { people, invalid } = parseAddressList(value)
  if (invalid.length > 0) {
    error.value = `${label}: ungültige Adresse „${invalid[0]}“.`
    return null
  }
  return people
}

function draftBody(): SaveDraftRequest {
  return {
    accountId: props.accountId,
    identityId: form.identityId || null,
    to: form.to,
    cc: form.cc,
    bcc: form.bcc,
    subject: form.subject,
    text: form.text,
    inReplyTo,
    references,
    attachmentIds: attachments.value.map((a) => a.id),
    baseVersion: version.value,
    ...(forceSaves ? { force: true } : {}),
  }
}

async function queueDraft(body: SaveDraftRequest | null): Promise<void> {
  await enqueueDraft(props.accountId, draftId, body)
  forceSaves = true
}

/** Saves the draft if it changed since the last save (serialized). */
async function saveDraft(options: { force?: boolean; keepalive?: boolean } = {}): Promise<void> {
  clearTimeout(saveTimer)
  while (saving) await saving
  if (finished || (conflict.value && !options.force)) return
  const snapshot = snapshotOf()
  if (snapshot === lastSaved.value && !options.force) return
  const body = draftBody()
  if (options.force) body.force = true
  saving = (async () => {
    saveState.value = 'saving'
    try {
      // Offline, or older operations still queued (order matters).
      if (navigator.onLine === false || offlineState.queue.length > 0) {
        await queueDraft(body)
        lastSaved.value = snapshot
        everSaved.value = true
        saveState.value = 'queued'
        return
      }
      let res: Response
      try {
        res = await fetch(`/api/drafts/${draftId}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          keepalive: options.keepalive,
        })
      } catch (err) {
        if (!isNetworkError(err)) throw err
        await queueDraft(body)
        lastSaved.value = snapshot
        everSaved.value = true
        saveState.value = 'queued'
        return
      }
      if (res.ok) {
        const draft = (await res.json()) as Draft
        version.value = draft.version
        lastSaved.value = snapshot
        everSaved.value = true
        saveState.value = 'saved'
        emit('draftsChanged')
      } else if (res.status === 409) {
        const payload = (await res.json().catch(() => null)) as DraftConflictResponse | null
        if (payload?.draft) conflict.value = payload.draft
        saveState.value = 'error'
      } else if (res.status === 410) {
        finished = true
        saveState.value = ''
        error.value = 'Dieser Entwurf wurde inzwischen gesendet oder verworfen.'
      } else {
        saveState.value = 'error'
      }
    } catch {
      saveState.value = 'error'
    }
  })()
  try {
    await saving
  } finally {
    saving = null
  }
}

function scheduleSave(): void {
  clearTimeout(saveTimer)
  if (finished || conflict.value || !dirty.value) return
  saveTimer = setTimeout(() => void saveDraft(), AUTOSAVE_DELAY_MS)
}

watch(form, scheduleSave, { deep: true })
watch(attachments, scheduleSave, { deep: true })

/** Conflict: replace the form with the version saved on the other device. */
function loadOtherVersion(): void {
  const other = conflict.value
  if (!other) return
  Object.assign(form, {
    identityId: other.identityId ?? form.identityId,
    to: other.to,
    cc: other.cc,
    bcc: other.bcc,
    subject: other.subject,
    text: other.text,
  })
  if (other.cc || other.bcc) showCcBcc.value = true
  attachments.value = [...other.attachments]
  version.value = other.version
  lastSaved.value = snapshotOf()
  conflict.value = null
  saveState.value = 'saved'
}

/** Conflict: overwrite the other version with this one (last write wins). */
function keepMine(): void {
  conflict.value = null
  void saveDraft({ force: true })
}

/** Closes the form and keeps the draft (saved right away if it changed). */
async function close(): Promise<void> {
  if (sending.value) return
  if (!finished && dirty.value) {
    await saveDraft()
    if (saveState.value === 'error' && !conflict.value) {
      if (!window.confirm('Der Entwurf konnte nicht gespeichert werden. Trotzdem schließen?')) {
        return
      }
    } else if (conflict.value) {
      return
    }
  }
  finished = true
  clearTimeout(saveTimer)
  // Saved drafts keep their attachments on the server.
  if (!everSaved.value) dropAttachments()
  emit('close')
}

/** Deletes the draft (after confirmation) and closes the form. */
async function discard(): Promise<void> {
  if (sending.value) return
  if (
    (dirty.value || everSaved.value) &&
    !window.confirm('Entwurf verwerfen? Der Text geht verloren.')
  ) {
    return
  }
  finished = true
  clearTimeout(saveTimer)
  while (saving) await saving
  if (everSaved.value) {
    try {
      if (navigator.onLine === false || offlineState.queue.length > 0) {
        await queueDraft(null)
      } else {
        const res = await fetch(`/api/drafts/${draftId}`, { method: 'DELETE' })
        if (!res.ok && res.status !== 404) throw new Error(`Fehler ${res.status}`)
      }
    } catch (err) {
      if (isNetworkError(err)) await queueDraft(null)
      else addNotice('Der Entwurf konnte nicht gelöscht werden.')
    }
    emit('draftsChanged')
  }
  dropAttachments()
  emit('close')
}

/** Saves a pending change when the page is hidden or closed (best effort). */
function onPageHide(event: Event): void {
  if (event.type === 'visibilitychange' && document.visibilityState !== 'hidden') return
  if (dirty.value) void saveDraft({ keepalive: true })
}

async function send(): Promise<void> {
  if (sending.value) return
  error.value = ''
  if (uploading.value > 0) {
    error.value = 'Bitte warten, bis alle Anhänge hochgeladen sind.'
    return
  }
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
    // The server deletes the draft with the send (unknown ids are ignored).
    draftId,
  }
  if (form.identityId) body.identityId = form.identityId
  if (inReplyTo) body.inReplyTo = inReplyTo
  if (references.length) body.references = references
  if (attachments.value.length) body.attachmentIds = attachments.value.map((a) => a.id)

  if (countdown.value > 0) return
  if (undoSendSeconds.value > 0 && !(await waitForUndoWindow(undoSendSeconds.value))) return

  sending.value = true
  // No autosave may race the send (it would answer 410 or recreate nothing).
  const wasFinished = finished
  finished = true
  clearTimeout(saveTimer)
  while (saving) await saving
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
      (OutboxMessage & Partial<AttachmentMissingResponse>) | null
    if (!res.ok || !payload) {
      finished = wasFinished
      if (payload?.code === ATTACHMENT_MISSING && payload.missingIds) {
        // Upload expired (form open for days) or removed: drop it from the
        // list, the user adds the file again. Nothing was sent.
        const missing = new Set(payload.missingIds)
        const names = attachments.value.filter((a) => missing.has(a.id)).map((a) => a.filename)
        attachments.value = attachments.value.filter((a) => !missing.has(a.id))
        error.value =
          `Nicht gesendet: ${names.length === 1 ? 'Der Anhang' : 'Die Anhänge'} ` +
          `${names.map((name) => `„${name}“`).join(', ')} ` +
          `${names.length === 1 ? 'ist' : 'sind'} nicht mehr vorhanden (abgelaufen). ` +
          'Bitte erneut hinzufügen und dann senden.'
        return
      }
      error.value = payload?.message ?? `Senden fehlgeschlagen (Fehler ${res.status}).`
      return
    }
    emit('queued', payload)
    if (everSaved.value) emit('draftsChanged')
    emit('close')
  } catch (err) {
    if (isNetworkError(err)) {
      await queueOffline(body)
      return
    }
    finished = wasFinished
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
    if (everSaved.value) emit('draftsChanged')
    emit('close')
  } finally {
    sending.value = false
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.defaultPrevented) return
  if (event.key === 'Escape' && countdown.value > 0) {
    event.preventDefault()
    undoSend()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    void close()
  } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault()
    void send()
  }
}

/** Forward: copies the original's attachments into uploads (server side). */
async function takeOverAttachments(messageId: string): Promise<void> {
  uploading.value++
  try {
    const res = await fetch(`/api/messages/${messageId}/attachments/copy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Inline images too: the forward is sent as text (#53).
      body: JSON.stringify({ accountId: props.accountId, includeInline: true }),
    })
    const payload = (await res.json().catch(() => null)) as
      (CopyAttachmentsResponse & { message?: string }) | null
    if (!res.ok || !payload) {
      error.value = `Anhänge des Originals: ${payload?.message ?? `nicht übernommen (Fehler ${res.status}).`}`
      return
    }
    if (finished) {
      for (const attachment of payload.attachments) {
        void fetch(`/api/uploads/${attachment.id}`, { method: 'DELETE' }).catch(() => {})
      }
      return
    }
    // Untouched form: the taken over attachments are part of the prefill.
    const untouched = snapshotOf() === lastSaved.value
    attachments.value.push(...payload.attachments)
    if (untouched) lastSaved.value = snapshotOf()
    if (payload.skipped > 0) {
      error.value =
        `${payload.skipped} ${payload.skipped === 1 ? 'Anhang wurde' : 'Anhänge wurden'} ` +
        'wegen der Größen- oder Anzahlgrenze nicht übernommen.'
    }
  } catch {
    error.value = 'Anhänge des Originals konnten nicht übernommen werden (offline?).'
  } finally {
    uploading.value--
  }
}

// MailView saves the draft before it closes the form (e.g. account switch).
defineExpose({ flush: () => saveDraft() })

onMounted(() => {
  window.addEventListener('pagehide', onPageHide)
  document.addEventListener('visibilitychange', onPageHide)
  if (props.forwardOf && !saved) void takeOverAttachments(props.forwardOf)
  if (saved?.attachmentsSkipped) {
    error.value =
      'Einige Anhänge konnten nicht übernommen werden; das Original bleibt im Entwürfe-Ordner erhalten.'
  }
  // New mail and forwards start with the recipients, replies with the text.
  if (props.draft.mode === 'new' || props.draft.mode === 'forward') {
    toInput.value?.focus()
  } else if (textInput.value) {
    textInput.value.focus()
    textInput.value.setSelectionRange(0, 0)
    textInput.value.scrollTop = 0
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('pagehide', onPageHide)
  document.removeEventListener('visibilitychange', onPageHide)
  clearTimeout(saveTimer)
})
</script>

<template>
  <div
    class="compose-backdrop"
    :class="{ 'in-pane': inPane && !inline, inline }"
    @keydown="onKeydown"
  >
    <form
      class="compose"
      :class="{ dragging }"
      role="dialog"
      :aria-modal="inPane || inline ? 'false' : 'true'"
      :aria-label="title"
      @submit.prevent="send"
      @dragover="onDragOver"
      @dragleave.self="dragging = false"
      @drop="onDrop"
    >
      <div v-if="dragging" class="drop-hint" aria-hidden="true">Dateien hier ablegen</div>
      <header class="compose-header">
        <h2>{{ title }}</h2>
        <span class="save-state" role="status">{{ saveLabel }}</span>
        <button type="button" class="icon" title="Schließen, Entwurf behalten (Esc)" @click="close">
          &times;
        </button>
      </header>

      <div v-if="conflict" class="conflict" role="alert">
        <p>
          Dieser Entwurf wurde inzwischen auf einem anderen Gerät geändert. Welche Fassung soll
          gelten?
        </p>
        <div class="buttons">
          <button type="button" class="secondary" @click="loadOtherVersion">
            Andere Fassung laden
          </button>
          <button type="button" class="primary" @click="keepMine">Meine Fassung behalten</button>
        </div>
      </div>

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
            role="combobox"
            aria-autocomplete="list"
            :aria-expanded="activeField === 'to' && suggestions.length > 0 ? 'true' : 'false'"
            aria-controls="recipient-suggestions-to"
            :aria-activedescendant="
              activeField === 'to' && suggestions.length > 0
                ? `recipient-to-${highlighted}`
                : undefined
            "
            :readonly="countdown > 0"
            placeholder="name@example.com, Name <name@example.com>"
            @focus="activeField = 'to'"
            @input="activeField = 'to'"
            @keydown="onRecipientKeydown"
            @blur="onRecipientBlur"
          />
          <ul
            v-if="activeField === 'to' && suggestions.length > 0"
            id="recipient-suggestions-to"
            class="suggestions"
            role="listbox"
          >
            <li
              v-for="(person, index) in suggestions"
              :id="`recipient-to-${index}`"
              :key="person.address"
              role="option"
              :aria-selected="index === highlighted ? 'true' : 'false'"
              @mousedown.prevent="choose(index)"
            >
              <strong v-if="person.name">{{ person.name }}</strong>
              <span>{{ person.address }}</span>
            </li>
          </ul>
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
            <input
              v-model="form.cc"
              type="text"
              inputmode="email"
              autocomplete="off"
              role="combobox"
              aria-autocomplete="list"
              :aria-expanded="activeField === 'cc' && suggestions.length > 0 ? 'true' : 'false'"
              aria-controls="recipient-suggestions-cc"
              :aria-activedescendant="
                activeField === 'cc' && suggestions.length > 0
                  ? `recipient-cc-${highlighted}`
                  : undefined
              "
              :readonly="countdown > 0"
              @focus="activeField = 'cc'"
              @input="activeField = 'cc'"
              @keydown="onRecipientKeydown"
              @blur="onRecipientBlur"
            />
            <ul
              v-if="activeField === 'cc' && suggestions.length > 0"
              id="recipient-suggestions-cc"
              class="suggestions"
              role="listbox"
            >
              <li
                v-for="(person, index) in suggestions"
                :id="`recipient-cc-${index}`"
                :key="person.address"
                role="option"
                :aria-selected="index === highlighted ? 'true' : 'false'"
                @mousedown.prevent="choose(index)"
              >
                <strong v-if="person.name">{{ person.name }}</strong>
                <span>{{ person.address }}</span>
              </li>
            </ul>
          </label>
          <label class="field">
            <span>Bcc</span>
            <input
              v-model="form.bcc"
              type="text"
              inputmode="email"
              autocomplete="off"
              role="combobox"
              aria-autocomplete="list"
              :aria-expanded="activeField === 'bcc' && suggestions.length > 0 ? 'true' : 'false'"
              aria-controls="recipient-suggestions-bcc"
              :aria-activedescendant="
                activeField === 'bcc' && suggestions.length > 0
                  ? `recipient-bcc-${highlighted}`
                  : undefined
              "
              :readonly="countdown > 0"
              @focus="activeField = 'bcc'"
              @input="activeField = 'bcc'"
              @keydown="onRecipientKeydown"
              @blur="onRecipientBlur"
            />
            <ul
              v-if="activeField === 'bcc' && suggestions.length > 0"
              id="recipient-suggestions-bcc"
              class="suggestions"
              role="listbox"
            >
              <li
                v-for="(person, index) in suggestions"
                :id="`recipient-bcc-${index}`"
                :key="person.address"
                role="option"
                :aria-selected="index === highlighted ? 'true' : 'false'"
                @mousedown.prevent="choose(index)"
              >
                <strong v-if="person.name">{{ person.name }}</strong>
                <span>{{ person.address }}</span>
              </li>
            </ul>
          </label>
        </template>
        <label class="field">
          <span>Betreff</span>
          <input
            v-model="form.subject"
            type="text"
            :maxlength="OUTBOX_LIMITS.maxSubjectLength"
            :readonly="countdown > 0"
          />
        </label>
      </div>

      <label class="body">
        <span class="visually-hidden">Nachricht</span>
        <textarea ref="textInput" v-model="form.text" spellcheck="true" :readonly="countdown > 0" />
      </label>

      <div class="attachments">
        <ul v-if="attachments.length > 0">
          <li v-for="attachment in attachments" :key="attachment.id">
            <span class="attachment-name" :title="attachment.filename">{{
              attachment.filename
            }}</span>
            <span class="attachment-size">{{ formatByteSize(attachment.size) }}</span>
            <button
              type="button"
              class="link"
              :disabled="sending"
              :aria-label="`Anhang ${attachment.filename} entfernen`"
              @click="removeAttachment(attachment)"
            >
              Entfernen
            </button>
          </li>
        </ul>
        <input ref="fileInput" type="file" multiple class="visually-hidden" @change="addFiles" />
        <button type="button" class="link" :disabled="sending" @click="fileInput?.click()">
          {{ uploading > 0 ? 'Wird hochgeladen …' : 'Anhang hinzufügen' }}
        </button>
      </div>

      <footer class="compose-footer">
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <p v-if="countdown > 0" class="countdown" role="status">
          Wird in {{ countdown }} s gesendet …
          <button type="button" class="link" @click="undoSend">Rückgängig</button>
        </p>
        <div v-else class="buttons">
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
.suggestions {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  z-index: 5;
  margin: 0.15rem 0 0;
  padding: 0.25rem;
  list-style: none;
  border: 1px solid var(--fma-border);
  border-radius: 0.375rem;
  background: var(--color-base-100);
  box-shadow: var(--fma-shadow);
}

.suggestions li {
  display: flex;
  flex-wrap: wrap;
  gap: 0 0.5rem;
  padding: 0.35rem 0.5rem;
  border-radius: 0.25rem;
  cursor: pointer;
  font-size: 0.9rem;
}

.suggestions li span {
  color: var(--fma-muted);
}

.suggestions li[aria-selected='true'],
.suggestions li:hover {
  background: var(--fma-primary-soft);
}

.compose.dragging {
  outline: 2px dashed var(--color-primary);
  outline-offset: -6px;
}

.drop-hint {
  position: absolute;
  inset: 0;
  z-index: 6;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in oklab, var(--color-base-100) 85%, transparent);
  color: var(--color-primary);
  font-weight: 600;
  pointer-events: none;
}

.countdown {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.75rem;
  margin: 0;
  font-weight: 600;
}

/* Reply below the conversation (#116). */
@media (min-width: 761px) {
  .compose-backdrop.inline {
    position: static;
    inset: auto;
    display: block;
    margin-top: 1rem;
    padding: 0;
    background: none;
  }

  .compose-backdrop.inline .compose {
    width: 100%;
    height: min(30rem, 70vh);
    border: 1px solid var(--fma-border);
    box-shadow: none;
  }
}

/* Reading pane (#116): in the grid area of the message, no overlay. */
@media (min-width: 761px) {
  .compose-backdrop.in-pane {
    position: relative;
    inset: auto;
    z-index: 4;
    grid-area: detail;
    padding: 0;
    background: none;
  }

  .compose-backdrop.in-pane .compose {
    width: 100%;
    height: 100%;
    border-radius: 0;
    box-shadow: none;
  }
}

.compose-backdrop {
  position: fixed;
  inset: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1.5rem;
  background: rgb(0 0 0 / 35%);
}

.compose {
  position: relative;
  display: flex;
  flex-direction: column;
  width: min(48rem, 100%);
  height: min(44rem, 100%);
  border-radius: 0.5rem;
  background: var(--color-base-100);
  box-shadow: 0 10px 40px rgb(0 0 0 / 25%);
  overflow: hidden;
}

.compose-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.75rem;
  padding: 0.6rem 1rem;
  border-bottom: 1px solid var(--color-base-300);
  background: var(--color-base-200);
}

h2 {
  margin: 0;
  font-size: 1.05rem;
}

.save-state {
  flex: 1;
  font-size: 0.8rem;
  color: var(--fma-muted);
}

.conflict {
  padding: 0.6rem 1rem;
  border-bottom: 1px solid var(--fma-warning-border);
  background: var(--fma-warning-soft);
  font-size: 0.9rem;
}

.conflict p {
  margin: 0 0 0.5rem;
}

button.icon {
  border: none;
  background: transparent;
  color: var(--fma-muted);
  font-size: 1.5rem;
  line-height: 1;
  cursor: pointer;
}

.fields {
  padding: 0.25rem 1rem;
  border-bottom: 1px solid var(--color-base-300);
}

.field {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.3rem 0;
  border-bottom: 1px solid var(--color-base-200);
}

.field:last-child {
  border-bottom: none;
}

.field > span {
  flex: 0 0 4rem;
  font-size: 0.85rem;
  color: var(--fma-muted);
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
  border-color: var(--fma-border-strong);
  outline: none;
}

button.link {
  border: none;
  background: transparent;
  color: var(--color-primary);
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
  border-top: 1px solid var(--color-base-300);
}

.buttons {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}

.attachments {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.35rem;
  /* Same horizontal inset as the fields and the message text. */
  padding: 0.4rem 1rem;
  font-size: 0.85rem;
}

.attachments ul {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  width: 100%;
  margin: 0;
  padding: 0;
  list-style: none;
}

.attachments li {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
  min-width: 0;
}

.attachment-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.attachment-size {
  flex: none;
  color: var(--fma-muted);
}

button.primary,
button.secondary {
  padding: 0.45rem 1rem;
  border: 1px solid var(--color-primary);
  border-radius: 0.375rem;
  font: inherit;
  cursor: pointer;
}

button.primary {
  background: var(--color-primary);
  color: var(--color-primary-content);
}

button.secondary {
  background: transparent;
  color: var(--color-primary);
}

button:disabled {
  opacity: 0.6;
  cursor: default;
}

.error {
  margin: 0 0 0.5rem;
  font-size: 0.85rem;
  color: var(--color-error);
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
