<script setup lang="ts">
// Account creation form with live connection test (roadmap 2.1).
const emit = defineEmits<{ created: [] }>()

const displayName = ref('')
const emailAddress = ref('')
const imapHost = ref('')
const imapPort = ref(993)
const imapUser = ref('')
const imapPassword = ref('')
const smtpHost = ref('')
const smtpPort = ref(465)
const smtpUser = ref('')
const smtpPassword = ref('')
const samePassword = ref(true)

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

async function submit(): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = ''
  success.value = ''
  try {
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
          user: smtpUser.value,
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
  <form class="form" @submit.prevent="submit">
    <h2>Konto hinzufügen</h2>
    <p class="hint">Verbindung wird vor dem Speichern getestet (IMAP + SMTP).</p>

    <label
      >E-Mail-Adresse des Kontos
      <input v-model="emailAddress" type="email" required placeholder="ich@provider.de" />
    </label>
    <label
      >Anzeigename (optional)
      <input v-model="displayName" type="text" placeholder="z. B. Privatisch" />
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
      <label>Benutzer<input v-model="imapUser" type="text" required autocomplete="off" /></label>
      <label
        >Passwort<input v-model="imapPassword" type="password" required autocomplete="new-password"
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
      <label class="checkbox">
        <input v-model="samePassword" type="checkbox" checked />
        Gleiche Zugangsdaten wie IMAP
      </label>
      <template v-if="!samePassword">
        <label>Benutzer<input v-model="smtpUser" type="text" autocomplete="off" /></label>
        <label
          >Passwort<input v-model="smtpPassword" type="password" autocomplete="new-password"
        /></label>
      </template>
    </fieldset>

    <button type="submit" :disabled="busy">
      {{ busy ? 'Teste Verbindung …' : 'Verbinden' }}
    </button>
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

button:disabled {
  opacity: 0.6;
  cursor: wait;
}
</style>
