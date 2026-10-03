<script setup lang="ts">
// Account form with live connection test: create (roadmap 2.1) and edit
// (roadmap 3.1, `account` prop). Stored credentials are never sent to the
// client; in edit mode empty user/password fields keep the stored values.
interface EditableAccount {
  id: string
  displayName: string
  emailAddress: string
  imap: { host: string; port: number }
  smtp: { host: string; port: number }
  sortOrder?: number
}

const props = defineProps<{ account?: EditableAccount }>()
const emit = defineEmits<{ created: []; saved: []; cancel: [] }>()
const editing = computed(() => !!props.account)

const displayName = ref(props.account?.displayName ?? '')
const emailAddress = ref(props.account?.emailAddress ?? '')
const sortOrder = ref(props.account?.sortOrder ?? 0)
const imapHost = ref(props.account?.imap.host ?? '')
const imapPort = ref(props.account?.imap.port ?? 993)
const imapUser = ref('')
const imapPassword = ref('')
const smtpHost = ref(props.account?.smtp.host ?? '')
const smtpPort = ref(props.account?.smtp.port ?? 465)
const smtpUser = ref('')
const smtpPassword = ref('')
// Edit mode: no checkbox; empty SMTP fields keep the stored credentials, and
// SMTP credentials that matched IMAP follow IMAP changes (api).
const samePassword = ref(!props.account)

const busy = ref(false)
const error = ref('')
const success = ref('')

const ERROR_TEXT: Record<string, string> = {
  AUTH_FAILED: 'Zugangsdaten wurden vom Server abgelehnt.',
  HOST_NOT_FOUND: 'Host nicht gefunden – bitte Namen prüfen.',
  BLOCKED_HOST: 'Interner Host ist blockiert (Schutz vor Server-seitigem Request Forging).',
  CONNECTION_REFUSED: 'Verbindung abgelehnt – Host und Port prüfen.',
  TIMEOUT: 'Zeitüberschreitung beim Verbinden.',
  TLS_ERROR: 'TLS-Fehler – das Server-Zertifikat konnte nicht verifiziert werden.',
}

function testErrorText(stage: 'imap' | 'smtp', test: { code?: string; message?: string }): string {
  if (test.code && ERROR_TEXT[test.code]) {
    return `${stage.toUpperCase()}: ${ERROR_TEXT[test.code]}`
  }
  return `${stage.toUpperCase()}: ${test.message ?? 'Verbindungstest fehlgeschlagen.'}`
}

/** PATCH body: only changed fields; connection data triggers a re-test. */
function updateBody(account: EditableAccount): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (displayName.value.trim() && displayName.value.trim() !== account.displayName) {
    body.displayName = displayName.value.trim()
  }
  if (sortOrder.value !== (account.sortOrder ?? 0)) body.sortOrder = sortOrder.value
  const imapChanged =
    imapHost.value !== account.imap.host ||
    imapPort.value !== account.imap.port ||
    !!imapUser.value ||
    !!imapPassword.value
  if (imapChanged) {
    body.imap = {
      host: imapHost.value,
      port: imapPort.value,
      user: imapUser.value,
      password: imapPassword.value,
    }
  }
  const smtpChanged =
    smtpHost.value !== account.smtp.host ||
    smtpPort.value !== account.smtp.port ||
    (!samePassword.value && (!!smtpUser.value || !!smtpPassword.value))
  if (smtpChanged) {
    body.smtp = {
      host: smtpHost.value,
      port: smtpPort.value,
      user: samePassword.value ? '' : smtpUser.value,
      password: samePassword.value ? '' : smtpPassword.value,
    }
  }
  return body
}

async function save(account: EditableAccount): Promise<void> {
  const body = updateBody(account)
  if (Object.keys(body).length === 0) {
    emit('saved')
    return
  }
  const res = await fetch(`/api/accounts/${account.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (res.status === 422) {
    const failed = (await res.json()) as {
      stage: 'imap' | 'smtp'
      test: { code?: string; message?: string }
    }
    error.value = testErrorText(failed.stage, failed.test)
    return
  }
  if (!res.ok) {
    const failed = (await res.json().catch(() => null)) as { message?: string } | null
    error.value = failed?.message ?? `Fehler ${res.status}`
    return
  }
  imapPassword.value = ''
  smtpPassword.value = ''
  emit('saved')
}

async function submit(): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = ''
  success.value = ''
  try {
    if (props.account) {
      await save(props.account)
      return
    }
    const res = await fetch('/api/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: displayName.value || undefined,
        emailAddress: emailAddress.value,
        imap: {
          host: imapHost.value,
          port: imapPort.value,
          user: imapUser.value,
          password: imapPassword.value,
        },
        smtp: {
          host: smtpHost.value,
          port: smtpPort.value,
          user: samePassword.value ? undefined : smtpUser.value,
          password: samePassword.value ? undefined : smtpPassword.value,
        },
      }),
    })
    if (res.status === 422) {
      const body = (await res.json()) as {
        stage: 'imap' | 'smtp'
        test: { code?: string; message?: string }
      }
      error.value = testErrorText(body.stage, body.test)
      return
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { message?: string } | null
      error.value = body?.message ?? `Fehler ${res.status}`
      return
    }
    success.value = 'Konto verbunden und gespeichert.'
    displayName.value = ''
    emailAddress.value = ''
    imapHost.value = ''
    imapUser.value = ''
    imapPassword.value = ''
    smtpHost.value = ''
    smtpUser.value = ''
    smtpPassword.value = ''
    emit('created')
  } catch {
    error.value = 'API nicht erreichbar.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <form class="form" :class="{ embedded: editing }" @submit.prevent="submit">
    <h2>{{ editing ? 'Konto bearbeiten' : 'Konto hinzufügen' }}</h2>
    <p class="hint">
      <template v-if="editing">
        Geänderte Verbindungsdaten werden vor dem Speichern getestet. Leere Benutzer-/Passwortfelder
        behalten die gespeicherten Zugangsdaten.
      </template>
      <template v-else>Verbindung wird vor dem Speichern getestet (IMAP + SMTP).</template>
    </p>

    <label v-if="!editing"
      >E-Mail-Adresse des Kontos
      <input v-model="emailAddress" type="email" required placeholder="ich@provider.de" />
    </label>
    <label
      >{{ editing ? 'Anzeigename' : 'Anzeigename (optional)' }}
      <input v-model="displayName" type="text" placeholder="z. B. Privat" :required="editing" />
    </label>
    <label v-if="editing"
      >Reihenfolge (kleinere Zahl zuerst)
      <input v-model.number="sortOrder" type="number" step="1" />
    </label>

    <fieldset>
      <legend>IMAP</legend>
      <div class="row">
        <label class="grow"
          >Host<input v-model="imapHost" type="text" required placeholder="imap.provider.de"
        /></label>
        <label class="port"
          >Port<input v-model.number="imapPort" type="number" min="1" max="65535" required
        /></label>
      </div>
      <label
        >Benutzer<input
          v-model="imapUser"
          type="text"
          :required="!editing"
          :placeholder="editing ? 'unverändert' : ''"
          autocomplete="off"
      /></label>
      <label
        >Passwort<input
          v-model="imapPassword"
          type="password"
          :required="!editing"
          :placeholder="editing ? 'unverändert' : ''"
          autocomplete="new-password"
      /></label>
    </fieldset>

    <fieldset>
      <legend>SMTP</legend>
      <div class="row">
        <label class="grow"
          >Host<input v-model="smtpHost" type="text" required placeholder="smtp.provider.de"
        /></label>
        <label class="port"
          >Port<input v-model.number="smtpPort" type="number" min="1" max="65535" required
        /></label>
      </div>
      <label v-if="!editing" class="checkbox">
        <input v-model="samePassword" type="checkbox" />
        Gleiche Zugangsdaten wie IMAP
      </label>
      <template v-if="!samePassword">
        <label
          >Benutzer<input
            v-model="smtpUser"
            type="text"
            :placeholder="editing ? 'unverändert bzw. wie IMAP' : ''"
            autocomplete="off"
        /></label>
        <label
          >Passwort<input
            v-model="smtpPassword"
            type="password"
            :placeholder="editing ? 'unverändert bzw. wie IMAP' : ''"
            autocomplete="new-password"
        /></label>
      </template>
    </fieldset>

    <span class="buttons">
      <button type="submit" :disabled="busy">
        {{ busy ? 'Teste Verbindung …' : editing ? 'Speichern' : 'Verbinden' }}
      </button>
      <button v-if="editing" type="button" class="secondary" @click="emit('cancel')">
        Abbrechen
      </button>
    </span>

    <p v-if="error" class="msg error">{{ error }}</p>
    <p v-else-if="success" class="msg success">{{ success }}</p>
  </form>
</template>

<style scoped>
.form {
  display: block;
  padding: 1rem 1.25rem;
  margin-bottom: 1rem;
  border: 1px solid #d5dde5;
  border-radius: 0.5rem;
  background: #f7f9fb;
}

h2 {
  margin: 0 0 0.25rem;
  font-size: 1.1rem;
}

.form.embedded {
  width: 100%;
  margin: 0.5rem 0 0;
  background: #fff;
}

.hint {
  margin: 0 0 0.75rem;
  font-size: 0.85rem;
  color: #52606d;
}

label {
  display: block;
  margin-bottom: 0.6rem;
  font-size: 0.9rem;
}

input {
  display: block;
  width: 100%;
  margin-top: 0.25rem;
  padding: 0.5rem;
  border: 1px solid #b8c2cc;
  border-radius: 0.375rem;
  box-sizing: border-box;
  font: inherit;
}

fieldset {
  border: 1px solid #d5dde5;
  border-radius: 0.375rem;
  margin: 0 0 0.75rem;
  padding: 0.75rem;
}

legend {
  font-size: 0.8rem;
  font-weight: 600;
  color: #52606d;
  padding: 0 0.25rem;
}

.row {
  display: flex;
  gap: 0.6rem;
}

.grow {
  flex: 1;
}

.port {
  width: 6rem;
}

.checkbox {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.checkbox input {
  width: auto;
  margin: 0;
}

button {
  padding: 0.5rem 1rem;
  border: none;
  border-radius: 0.375rem;
  background: #1273de;
  color: #fff;
  font: inherit;
  cursor: pointer;
}

.buttons {
  display: flex;
  gap: 0.5rem;
}

button.secondary {
  background: #e4e9ee;
  color: #1f2933;
}

button:disabled {
  opacity: 0.6;
  cursor: wait;
}

.msg {
  margin: 0.75rem 0 0;
  padding: 0.75rem 1rem;
  border-radius: 0.375rem;
  font-size: 0.9rem;
}

.msg.error {
  background: #fde8e8;
  color: #9b1c1c;
}

.msg.success {
  background: #def7ec;
  color: #046c4e;
}
</style>
