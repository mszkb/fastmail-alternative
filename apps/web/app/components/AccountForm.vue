<script setup lang="ts">
// Account form with live connection test: create (roadmap 2.1) and edit
// (roadmap 3.1, `account` prop). Stored credentials are never sent to the
// client; in edit mode empty user/password fields keep the stored values.
// Provider presets (#117): picking a provider (or typing an address of a
// known domain) fills server, ports and user name and shows how to get the
// password the provider expects (e.g. an app password at Fastmail).
// Sign-in with Google/Microsoft (#36): offered for the Gmail and Microsoft
// presets when the server has the provider configured; OAuth accounts sign
// in again instead of editing credentials.
import {
  OAUTH_PROVIDER_LABELS,
  PROVIDER_PRESETS,
  SYNC_SINCE_CHOICES,
  presetById,
  presetFields,
  presetForAddress,
  syncSinceFromDays,
} from '@fma/shared'
import type { OAuthProviderId, OAuthProvidersResponse, ProviderPreset } from '@fma/shared'

interface EditableAccount {
  id: string
  displayName: string
  emailAddress: string
  imap: { host: string; port: number }
  smtp: { host: string; port: number }
  sortOrder?: number
  syncSince?: string | null
  credentialKind?: 'password' | 'oauth2'
  oauthProvider?: OAuthProviderId | null
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
// Sync period (#28): 'keep' = stored day unchanged, 'all' = no limit, else
// days before today (converted to a day on save).
const storedSyncSince = props.account?.syncSince ?? null
const syncChoice = ref<string>(storedSyncSince ? 'keep' : 'all')
const syncChoices = computed(() => [
  ...(storedSyncSince
    ? [
        {
          value: 'keep',
          label: `Seit ${new Date(`${storedSyncSince}T00:00:00Z`).toLocaleDateString('de-DE', { timeZone: 'UTC' })}`,
        },
      ]
    : []),
  ...SYNC_SINCE_CHOICES.map((choice) => ({
    value: choice.days === null ? 'all' : String(choice.days),
    label: choice.label,
  })),
])

/** Chosen `syncSince` (`YYYY-MM-DD` or null); undefined = unchanged. */
function chosenSyncSince(): string | null | undefined {
  if (syncChoice.value === 'keep') return undefined
  if (syncChoice.value === 'all') return null
  return syncSinceFromDays(Number(syncChoice.value))
}

// Provider preset ('' = own server); only offered when adding an account.
const presetId = ref('')
const preset = computed(() => (presetId.value ? presetById(presetId.value) : undefined))
// A provider (or "Eigener Server") was picked by hand: no auto-detection.
let presetChosenByUser = false

function applyPreset(): void {
  const chosen = preset.value
  if (!chosen) return
  const fields = presetFields(chosen, emailAddress.value)
  imapHost.value = fields.imapHost
  imapPort.value = fields.imapPort
  smtpHost.value = fields.smtpHost
  smtpPort.value = fields.smtpPort
  if (fields.user) imapUser.value = fields.user
  samePassword.value = true
}

/**
 * The address no longer matches the auto-detected provider: drop it and
 * its server values (those still as the preset filled them).
 */
function clearAutoPreset(previous: ProviderPreset): void {
  const fields = presetFields(previous, '')
  if (imapHost.value === fields.imapHost) imapHost.value = ''
  if (smtpHost.value === fields.smtpHost) smtpHost.value = ''
  presetId.value = ''
}

function onPresetChange(): void {
  presetChosenByUser = true
  applyPreset()
}

/** Known address domain: suggest its preset once, unless chosen by hand. */
function onAddressChange(): void {
  if (editing.value) return
  const detected = presetForAddress(emailAddress.value)
  if (detected && !presetChosenByUser && presetId.value !== detected.id) {
    presetId.value = detected.id
    applyPreset()
  } else if (!detected && !presetChosenByUser && preset.value) {
    clearAutoPreset(preset.value)
  } else if (preset.value && (!imapUser.value || imapUser.value.includes('@'))) {
    imapUser.value = emailAddress.value.trim()
  }
}

const busy = ref(false)
const error = ref('')
const success = ref('')

// OAuth providers configured on the server; unknown (offline) = none.
const oauthConfigured = ref<Partial<Record<OAuthProviderId, boolean>>>({})
const isOAuthAccount = computed(() => props.account?.credentialKind === 'oauth2')
/** Provider of the sign-in button: the OAuth account's, or the chosen preset's. */
const oauthProvider = computed<OAuthProviderId | null>(() =>
  props.account
    ? isOAuthAccount.value
      ? (props.account.oauthProvider ?? null)
      : null
    : (preset.value?.oauth ?? null),
)
const canSignIn = computed(
  () => !!oauthProvider.value && oauthConfigured.value[oauthProvider.value] === true,
)
const oauthLabel = computed(() =>
  oauthProvider.value ? OAUTH_PROVIDER_LABELS[oauthProvider.value] : '',
)
// Microsoft has no password login: only the button, no server fields.
const signInOnly = computed(
  () => isOAuthAccount.value || (canSignIn.value && preset.value?.auth === 'oauth-only'),
)

onMounted(async () => {
  try {
    const res = await fetch('/api/oauth/providers')
    if (res.ok) oauthConfigured.value = ((await res.json()) as OAuthProvidersResponse).providers
  } catch {
    // Offline: no sign-in button.
  }
})

/** Leaves the app for the provider's sign-in page; it returns to /?oauth=... */
async function signIn(): Promise<void> {
  if (busy.value || !oauthProvider.value) return
  busy.value = true
  error.value = ''
  try {
    const res = await fetch(`/api/oauth/${oauthProvider.value}/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(props.account ? { accountId: props.account.id } : {}),
    })
    const body = (await res.json().catch(() => null)) as { url?: string; message?: string } | null
    if (!res.ok || !body?.url) {
      error.value = body?.message ?? `Fehler ${res.status}`
      busy.value = false
      return
    }
    window.location.assign(body.url)
  } catch {
    error.value = 'API nicht erreichbar.'
    busy.value = false
  }
}

const ERROR_TEXT: Record<string, string> = {
  AUTH_FAILED: 'Zugangsdaten wurden vom Server abgelehnt.',
  HOST_NOT_FOUND: 'Host nicht gefunden – bitte Namen prüfen.',
  BLOCKED_HOST: 'Interner Host ist blockiert (Schutz vor Server-seitigem Request Forging).',
  BLOCKED_PORT:
    'Port nicht erlaubt – IMAP 143/993, SMTP 25/465/587/2525 (weitere per MAIL_EXTRA_PORTS auf dem Server).',
  CONNECTION_REFUSED: 'Verbindung abgelehnt – Host und Port prüfen.',
  TIMEOUT: 'Zeitüberschreitung beim Verbinden.',
  TLS_ERROR: 'TLS-Fehler – das Server-Zertifikat konnte nicht verifiziert werden.',
  TLS_REQUIRED:
    'Der Server bietet keine verschlüsselte Verbindung (STARTTLS) an – das Passwort wurde nicht gesendet. Einen TLS-Port (IMAP 993, SMTP 465) verwenden.',
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
  const syncSince = chosenSyncSince()
  if (syncSince !== undefined && syncSince !== (account.syncSince ?? null)) {
    body.syncSince = syncSince
  }
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
    if (signInOnly.value) {
      // Enter in the address field: the only way on is the provider's sign-in.
      busy.value = false
      await signIn()
      return
    }
    const res = await fetch('/api/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: displayName.value || undefined,
        emailAddress: emailAddress.value,
        syncSince: chosenSyncSince() ?? undefined,
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
    syncChoice.value = 'all'
    presetId.value = ''
    presetChosenByUser = false
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
      <template v-if="isOAuthAccount">
        Angemeldet über {{ oauthLabel || 'den Anbieter' }}. Die Zugangsdaten verwaltet der Anbieter;
        bei abgelaufener Anmeldung hier neu anmelden.
      </template>
      <template v-else-if="editing">
        Geänderte Verbindungsdaten werden vor dem Speichern getestet. Leere Benutzer-/Passwortfelder
        behalten die gespeicherten Zugangsdaten.
      </template>
      <template v-else>Verbindung wird vor dem Speichern getestet (IMAP + SMTP).</template>
    </p>

    <label v-if="!editing"
      >E-Mail-Adresse des Kontos
      <input
        v-model="emailAddress"
        type="email"
        required
        placeholder="ich@provider.de"
        @change="onAddressChange"
      />
    </label>
    <label v-if="!editing"
      >Anbieter
      <select v-model="presetId" @change="onPresetChange">
        <option value="">Eigener Server (Daten selbst eingeben)</option>
        <option v-for="option in PROVIDER_PRESETS" :key="option.id" :value="option.id">
          {{ option.label }}
        </option>
      </select>
    </label>
    <p
      v-if="!editing && preset && !signInOnly"
      class="preset-hint"
      :class="{ blocked: preset.auth === 'oauth-only' }"
      role="note"
    >
      {{ preset.hint }}
    </p>
    <div v-if="canSignIn" class="oauth">
      <button type="button" :disabled="busy" @click="signIn">
        {{ isOAuthAccount ? `Neu anmelden bei ${oauthLabel}` : `Mit ${oauthLabel} anmelden` }}
      </button>
      <span class="hint">
        <template v-if="isOAuthAccount"
          >Die Anmeldung muss mit {{ account?.emailAddress }} erfolgen.</template
        >
        <template v-else
          >Weiter zur Anmeldeseite von {{ oauthLabel }}; danach geht es hierher zurück. Es werden
          alle Mails synchronisiert – der Zeitraum lässt sich danach unter „Bearbeiten“
          einschränken.</template
        >
      </span>
      <p v-if="!signInOnly" class="or">oder mit App-Passwort:</p>
    </div>
    <p v-else-if="isOAuthAccount" class="preset-hint blocked" role="note">
      Die Anmeldung über {{ oauthLabel || 'diesen Anbieter' }} ist auf dem Server nicht (mehr)
      eingerichtet; ohne sie kann das Konto nicht abgeglichen werden.
    </p>
    <label v-if="!signInOnly || editing"
      >{{ editing ? 'Anzeigename' : 'Anzeigename (optional)' }}
      <input v-model="displayName" type="text" placeholder="z. B. Privat" :required="editing" />
    </label>
    <label v-if="editing"
      >Reihenfolge (kleinere Zahl zuerst)
      <input v-model.number="sortOrder" type="number" step="1" />
    </label>
    <label v-if="!signInOnly || editing"
      >Mails synchronisieren
      <select v-model="syncChoice">
        <option v-for="choice in syncChoices" :key="choice.value" :value="choice.value">
          {{ choice.label }}
        </option>
      </select>
      <span class="hint sync-hint"
        >Gilt für neue Mails nach Empfangsdatum. Bereits geladene ältere Mails bleiben erhalten;
        „Ältere Mails laden“ holt sie trotzdem.</span
      >
    </label>

    <fieldset v-if="!signInOnly">
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

    <fieldset v-if="!signInOnly">
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

    <span v-if="!signInOnly || editing" class="buttons">
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
.preset-hint {
  margin: -0.25rem 0 var(--fma-space-3);
  padding: var(--fma-space-2) var(--fma-space-3);
  border-left: 3px solid var(--color-primary);
  border-radius: 0.25rem;
  background: var(--fma-primary-soft);
  font-size: var(--fma-text-sm);
}

.oauth {
  margin: 0 0 var(--fma-space-3);
}

.oauth .hint {
  display: block;
  margin: var(--fma-space-1) 0 0;
}

.oauth .or {
  margin: var(--fma-space-3) 0 0;
  font-size: var(--fma-text-sm);
  font-weight: 600;
}

.preset-hint.blocked {
  border-left-color: var(--color-error);
  background: var(--fma-error-soft);
}

.form {
  display: block;
  padding: var(--fma-space-4) 1.25rem;
  margin-bottom: var(--fma-space-4);
  border: 1px solid var(--fma-border);
  border-radius: var(--fma-radius-box);
  background: var(--color-base-200);
}

h2 {
  margin: 0 0 var(--fma-space-1);
  font-size: var(--fma-text-lg);
}

.form.embedded {
  width: 100%;
  margin: var(--fma-space-2) 0 0;
  background: var(--color-base-100);
}

.hint {
  margin: 0 0 var(--fma-space-3);
  font-size: var(--fma-text-sm);
  color: var(--fma-muted);
}

.sync-hint {
  display: block;
  margin: var(--fma-space-1) 0 0;
}

label {
  display: block;
  margin-bottom: 0.6rem;
  font-size: 0.9rem;
}

input,
select {
  display: block;
  width: 100%;
  margin-top: var(--fma-space-1);
  padding: var(--fma-space-2);
  border: 1px solid var(--fma-border-strong);
  border-radius: var(--fma-radius);
  box-sizing: border-box;
  font: inherit;
}

fieldset {
  border: 1px solid var(--fma-border);
  border-radius: var(--fma-radius);
  margin: 0 0 var(--fma-space-3);
  padding: var(--fma-space-3);
}

legend {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--fma-muted);
  padding: 0 var(--fma-space-1);
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
  padding: var(--fma-space-2) var(--fma-space-4);
  border: none;
  border-radius: var(--fma-radius);
  background: var(--color-primary);
  color: var(--color-primary-content);
  font: inherit;
  cursor: pointer;
}

.buttons {
  display: flex;
  gap: var(--fma-space-2);
}

button.secondary {
  background: var(--color-base-300);
  color: var(--color-base-content);
}

button:disabled {
  opacity: 0.6;
  cursor: wait;
}

.msg {
  margin: var(--fma-space-3) 0 0;
  padding: var(--fma-space-3) var(--fma-space-4);
  border-radius: var(--fma-radius);
  font-size: 0.9rem;
}

.msg.error {
  background: var(--fma-error-soft);
  color: var(--color-error);
}

.msg.success {
  background: var(--fma-success-soft);
  color: var(--color-success);
}
</style>
