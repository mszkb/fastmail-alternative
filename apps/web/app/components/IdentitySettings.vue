<script setup lang="ts">
// Sender identities of an account (roadmap 2.6, 3.6): add aliases (name +
// address), edit display name and signature, choose the default identity,
// remove non-default ones. Replies pick the identity the original was
// addressed to automatically (pickIdentity in @fma/shared).
import {
  MAX_IDENTITY_NAME_LENGTH,
  MAX_SIGNATURE_LENGTH,
  type ComposeIdentity,
  type IdentityListResponse,
} from '@fma/shared'

const props = defineProps<{ accountId: string }>()

const identities = ref<ComposeIdentity[]>([])
const drafts = reactive<Record<string, { name: string; signature: string }>>({})
const busy = ref('')
const saved = ref('')
const error = ref('')
const loading = ref(true)
const newIdentity = reactive({ name: '', emailAddress: '' })

async function request<T>(url: string, method: string, body?: unknown): Promise<T | null> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (res.status === 204) return null
  const json = (await res.json().catch(() => null)) as (T & { message?: string }) | null
  if (!res.ok) throw new Error(json?.message ?? `Fehler ${res.status}`)
  return json
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const body = await request<IdentityListResponse>(
      `/api/accounts/${props.accountId}/identities`,
      'GET',
    )
    identities.value = body?.identities ?? []
    for (const identity of identities.value) {
      drafts[identity.id] = { name: identity.name, signature: identity.signature ?? '' }
    }
  } catch {
    error.value = 'Identitäten konnten nicht geladen werden.'
  } finally {
    loading.value = false
  }
}

function changed(identity: ComposeIdentity): boolean {
  const draft = drafts[identity.id]
  return !!draft && (draft.name !== identity.name || draft.signature !== (identity.signature ?? ''))
}

/** Runs one action with busy/error handling, then reloads the list. */
async function run(key: string, action: () => Promise<unknown>): Promise<void> {
  if (busy.value) return
  busy.value = key
  saved.value = ''
  error.value = ''
  try {
    await action()
    await load()
    saved.value = key
  } catch (err) {
    error.value = err instanceof TypeError ? 'API nicht erreichbar.' : (err as Error).message
  } finally {
    busy.value = ''
  }
}

function save(identity: ComposeIdentity): Promise<void> {
  const draft = drafts[identity.id]!
  return run(identity.id, () =>
    request(`/api/identities/${identity.id}`, 'PATCH', {
      name: draft.name,
      signature: draft.signature || null,
    }),
  )
}

function makeDefault(identity: ComposeIdentity): Promise<void> {
  return run(identity.id, () =>
    request(`/api/identities/${identity.id}`, 'PATCH', { isDefault: true }),
  )
}

function remove(identity: ComposeIdentity): Promise<void> {
  if (!confirm(`Identität „${identity.emailAddress}“ entfernen?`)) return Promise.resolve()
  return run(identity.id, () => request(`/api/identities/${identity.id}`, 'DELETE'))
}

function add(): Promise<void> {
  return run('new', async () => {
    await request(`/api/accounts/${props.accountId}/identities`, 'POST', { ...newIdentity })
    newIdentity.name = ''
    newIdentity.emailAddress = ''
  })
}

onMounted(load)
</script>

<template>
  <div class="identities">
    <p v-if="loading" class="hint">Wird geladen &hellip;</p>
    <div v-for="identity in identities" :key="identity.id" class="identity">
      <div class="head">
        <strong>{{ identity.emailAddress }}</strong>
        <span v-if="identity.isDefault" class="tag">Standard</span>
      </div>
      <template v-if="drafts[identity.id]">
        <label :for="`name-${identity.id}`">Anzeigename</label>
        <input
          :id="`name-${identity.id}`"
          v-model="drafts[identity.id]!.name"
          type="text"
          :maxlength="MAX_IDENTITY_NAME_LENGTH"
          placeholder="z. B. Martin Beispiel"
        />
        <label :for="`signature-${identity.id}`">Signatur</label>
        <textarea
          :id="`signature-${identity.id}`"
          v-model="drafts[identity.id]!.signature"
          rows="3"
          :maxlength="MAX_SIGNATURE_LENGTH"
          placeholder="z. B. Name, Telefonnummer"
        />
      </template>
      <div class="row">
        <button type="button" :disabled="!!busy || !changed(identity)" @click="save(identity)">
          Speichern
        </button>
        <button
          v-if="!identity.isDefault"
          type="button"
          :disabled="!!busy"
          @click="makeDefault(identity)"
        >
          Als Standard
        </button>
        <button
          v-if="!identity.isDefault"
          type="button"
          class="danger"
          :disabled="!!busy"
          @click="remove(identity)"
        >
          Entfernen
        </button>
        <span v-if="saved === identity.id" class="ok">Gespeichert.</span>
      </div>
    </div>

    <form class="identity add" @submit.prevent="add">
      <strong>Weitere Absenderadresse (Alias)</strong>
      <label for="new-identity-name">Anzeigename</label>
      <input
        id="new-identity-name"
        v-model="newIdentity.name"
        type="text"
        :maxlength="MAX_IDENTITY_NAME_LENGTH"
      />
      <label for="new-identity-address">E-Mail-Adresse</label>
      <input
        id="new-identity-address"
        v-model="newIdentity.emailAddress"
        type="email"
        required
        placeholder="info@example.com"
      />
      <div class="row">
        <button type="submit" :disabled="!!busy">Hinzufügen</button>
        <span v-if="saved === 'new'" class="ok">Hinzugefügt.</span>
      </div>
    </form>
    <p class="hint">
      Die Signatur wird beim Schreiben mit „-- “ abgetrennt unter dem eigenen Text eingefügt.
      Antworten nutzen automatisch die Adresse, an die die Nachricht ging, sonst die
      Standard-Identität. Ob der Anbieter einen Alias als Absender akzeptiert, hängt vom Anbieter
      ab.
    </p>
    <p v-if="error" class="error">{{ error }}</p>
  </div>
</template>

<style scoped>
.identities {
  flex-basis: 100%;
  padding: 0.5rem 0 0.25rem;
}

.identity {
  margin-bottom: 0.75rem;
  padding-bottom: 0.75rem;
  border-bottom: 1px solid #e4e9ee;
}

.head {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.9rem;
}

.tag {
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  background: #d9f2e4;
  font-size: 0.75rem;
  color: #147d46;
}

label {
  display: block;
  margin: 0.4rem 0 0.2rem;
  font-size: 0.85rem;
}

input,
textarea {
  box-sizing: border-box;
  width: 100%;
  padding: 0.45rem;
  border: 1px solid #b8c2cc;
  border-radius: 0.375rem;
  font: inherit;
  font-size: 0.9rem;
}

.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.4rem;
}

button {
  padding: 0.35rem 0.8rem;
  border: 1px solid #1273de;
  border-radius: 0.375rem;
  background: transparent;
  color: #1273de;
  font: inherit;
  cursor: pointer;
}

button.danger {
  border-color: #cf1124;
  color: #cf1124;
}

button:disabled {
  opacity: 0.6;
  cursor: default;
}

.ok {
  font-size: 0.8rem;
  color: #18794e;
}

.hint {
  margin: 0;
  font-size: 0.8rem;
  color: #52606d;
}

.error {
  margin: 0.25rem 0 0;
  font-size: 0.85rem;
  color: #9b1c1c;
}
</style>
