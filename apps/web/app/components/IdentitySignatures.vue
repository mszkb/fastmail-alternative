<script setup lang="ts">
// Signature editor per sender identity (roadmap 2.6): the signature is
// inserted below the own text and above the quote when composing.
// Managing identities themselves follows in 3.6.
import { MAX_SIGNATURE_LENGTH, type ComposeIdentity, type IdentityListResponse } from '@fma/shared'

const props = defineProps<{ accountId: string }>()

const identities = ref<ComposeIdentity[]>([])
const drafts = reactive<Record<string, string>>({})
const saving = ref('')
const saved = ref('')
const error = ref('')
const loading = ref(true)

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const res = await fetch(`/api/accounts/${props.accountId}/identities`)
    if (!res.ok) throw new Error()
    const body = (await res.json()) as IdentityListResponse
    identities.value = body.identities
    for (const identity of body.identities) drafts[identity.id] = identity.signature ?? ''
  } catch {
    error.value = 'Identitäten konnten nicht geladen werden.'
  } finally {
    loading.value = false
  }
}

async function save(identity: ComposeIdentity): Promise<void> {
  if (saving.value) return
  saving.value = identity.id
  saved.value = ''
  error.value = ''
  try {
    const res = await fetch(`/api/identities/${identity.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signature: drafts[identity.id] || null }),
    })
    const body = (await res.json().catch(() => null)) as {
      identity?: ComposeIdentity
      message?: string
    } | null
    if (!res.ok || !body?.identity) {
      error.value = body?.message ?? `Fehler ${res.status}`
      return
    }
    identity.signature = body.identity.signature
    drafts[identity.id] = body.identity.signature ?? ''
    saved.value = identity.id
  } catch {
    error.value = 'API nicht erreichbar.'
  } finally {
    saving.value = ''
  }
}

onMounted(load)
</script>

<template>
  <div class="signatures">
    <p v-if="loading" class="hint">Wird geladen &hellip;</p>
    <div v-for="identity in identities" :key="identity.id" class="identity">
      <label :for="`signature-${identity.id}`">
        Signatur für
        {{ identity.name ? `${identity.name} <${identity.emailAddress}>` : identity.emailAddress }}
      </label>
      <textarea
        :id="`signature-${identity.id}`"
        v-model="drafts[identity.id]"
        rows="4"
        :maxlength="MAX_SIGNATURE_LENGTH"
        placeholder="z. B. Name, Telefonnummer"
      />
      <div class="row">
        <button
          type="button"
          :disabled="saving === identity.id || drafts[identity.id] === (identity.signature ?? '')"
          @click="save(identity)"
        >
          Speichern
        </button>
        <span v-if="saved === identity.id" class="ok">Gespeichert.</span>
      </div>
    </div>
    <p class="hint">Wird beim Schreiben mit „-- “ abgetrennt unter dem eigenen Text eingefügt.</p>
    <p v-if="error" class="error">{{ error }}</p>
  </div>
</template>

<style scoped>
.signatures {
  flex-basis: 100%;
  padding: 0.5rem 0 0.25rem;
}

.identity {
  margin-bottom: 0.75rem;
}

label {
  display: block;
  margin-bottom: 0.25rem;
  font-size: 0.85rem;
}

textarea {
  box-sizing: border-box;
  width: 100%;
  padding: 0.5rem;
  border: 1px solid #b8c2cc;
  border-radius: 0.375rem;
  font: inherit;
  font-size: 0.9rem;
}

.row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.35rem;
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
