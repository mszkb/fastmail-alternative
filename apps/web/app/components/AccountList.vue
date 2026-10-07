<script setup lang="ts">
// Account list in the settings (roadmap 2.1/3.1): edit, identities (3.6), folder
// mapping (3.3), remove, storage usage (5.4);
// connection problems (3.4) are explained in German with the edit action.
import {
  accountStatusInfo,
  formatByteSize,
  storageSummary,
  type AccountStorage,
  type AccountSummary,
  type StorageResponse,
} from '@fma/shared'

type Account = Pick<
  AccountSummary,
  'id' | 'displayName' | 'emailAddress' | 'imap' | 'smtp' | 'status' | 'lastErrorCode'
> & { sortOrder?: number }

const props = defineProps<{ accounts: Account[] }>()
const emit = defineEmits<{ deleted: [id: string]; changed: [id: string] }>()

const busy = ref(false)
const error = ref('')
// Account whose identity settings (signature, aliases, default) are open.
const editing = ref('')
// Account whose folder mapping (3.3) is open.
const mapping = ref('')
// Account whose edit form is open (also opened from the mail view, e.g.
// "Zugangsdaten aktualisieren").
const editingAccount = defineModel<string>('edit', { default: '' })

// Storage usage per account (5.4): numbers only, loaded with the list;
// a failure just hides the line.
const storage = ref<StorageResponse | null>(null)

// Only the latest request may set the result, so a slow older response
// never overwrites a newer one.
let storageRequest = 0

async function loadStorage(): Promise<void> {
  const seq = ++storageRequest
  let result: StorageResponse | null = null
  try {
    const res = await fetch('/api/storage')
    if (res.ok) result = (await res.json()) as StorageResponse
  } catch {
    result = null
  }
  if (seq === storageRequest) storage.value = result
}

function storageOf(id: string): AccountStorage | undefined {
  return storage.value?.accounts.find((s) => s.accountId === id)
}

onMounted(loadStorage)
watch(
  () => props.accounts.map((a) => a.id).join(),
  () => void loadStorage(),
)

function onSaved(id: string): void {
  editingAccount.value = ''
  emit('changed', id)
}

async function remove(account: Account): Promise<void> {
  if (busy.value) return
  if (
    !confirm(
      `Konto „${account.displayName}“ wirklich entfernen?\n\n` +
        'Zugangsdaten, Ordner, zwischengespeicherte Nachrichten und der Postausgang dieses ' +
        'Kontos werden auf diesem Server gelöscht. Die Nachrichten beim Mailanbieter bleiben ' +
        'unverändert.',
    )
  )
    return
  busy.value = true
  error.value = ''
  try {
    const res = await fetch(`/api/accounts/${account.id}`, { method: 'DELETE' })
    if (!res.ok && res.status !== 404) {
      const body = (await res.json().catch(() => null)) as { message?: string } | null
      error.value = body?.message ?? `Fehler ${res.status}`
      return
    }
    emit('deleted', account.id)
  } catch {
    error.value = 'API nicht erreichbar.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="card">
    <h2>Konten</h2>
    <p v-if="accounts.length === 0" class="hint">Noch keine Konten verbunden.</p>
    <ul v-else class="accounts">
      <li v-for="account in accounts" :key="account.id">
        <span>
          <strong>{{ account.displayName }}</strong>
          <span class="mail">{{ account.emailAddress }}</span>
          <span v-if="accountStatusInfo(account)" class="tag problem">{{
            accountStatusInfo(account)!.label
          }}</span>
          <span v-else class="tag">verbunden</span>
        </span>
        <span class="actions">
          <button
            type="button"
            class="neutral"
            :aria-expanded="editingAccount === account.id"
            @click="editingAccount = editingAccount === account.id ? '' : account.id"
          >
            Bearbeiten
          </button>
          <button
            type="button"
            class="neutral"
            :aria-expanded="editing === account.id"
            @click="editing = editing === account.id ? '' : account.id"
          >
            Identitäten
          </button>
          <button
            type="button"
            class="neutral"
            :aria-expanded="mapping === account.id"
            @click="mapping = mapping === account.id ? '' : account.id"
          >
            Ordner
          </button>
          <button type="button" :disabled="busy" @click="remove(account)">Entfernen</button>
        </span>
        <p v-if="storageOf(account.id)" class="storage">
          Speicher: {{ storageSummary(storageOf(account.id)!) }}
        </p>
        <p v-if="accountStatusInfo(account)" class="status-text">
          {{ accountStatusInfo(account)!.description }}
        </p>
        <AccountForm
          v-if="editingAccount === account.id"
          :account="account"
          @saved="onSaved(account.id)"
          @cancel="editingAccount = ''"
        />
        <IdentitySettings v-if="editing === account.id" :account-id="account.id" />
        <FolderRoles v-if="mapping === account.id" :account-id="account.id" />
      </li>
    </ul>
    <p v-if="storage && storage.accounts.length > 1" class="hint storage-total">
      Speicher gesamt: ca. {{ formatByteSize(storage.totalBytes) }}
    </p>
    <p v-if="error" class="error">{{ error }}</p>
  </div>
</template>

<style scoped>
.card {
  padding: 1rem 1.25rem;
  margin-bottom: 1rem;
  border: 1px solid var(--fma-border);
  border-radius: 0.5rem;
  background: var(--color-base-200);
}

h2 {
  margin: 0 0 0.5rem;
  font-size: 1.1rem;
}

.hint {
  margin: 0;
  font-size: 0.85rem;
  color: var(--fma-muted);
}

.accounts {
  list-style: none;
  margin: 0;
  padding: 0;
}

.accounts li {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.5rem 0;
  border-bottom: 1px solid var(--color-base-300);
}

.accounts li:last-child {
  border-bottom: none;
}

.mail {
  display: block;
  font-size: 0.8rem;
  color: var(--fma-muted);
}

.tag.problem {
  background: var(--fma-error-soft);
  color: var(--color-error);
}

.storage {
  width: 100%;
  margin: 0;
  font-size: 0.8rem;
  color: var(--fma-muted);
}

.storage-total {
  margin-top: 0.5rem;
}

.status-text {
  width: 100%;
  margin: 0;
  font-size: 0.85rem;
  color: var(--fma-warning-text);
}

.tag {
  display: inline-block;
  margin-left: 0.4rem;
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  background: var(--fma-success-soft);
  font-size: 0.75rem;
  color: var(--color-success);
}

button {
  padding: 0.4rem 0.8rem;
  border: 1px solid var(--color-error);
  border-radius: 0.375rem;
  background: transparent;
  color: var(--color-error);
  font: inherit;
  cursor: pointer;
}

button.neutral {
  border-color: var(--color-primary);
  color: var(--color-primary);
}

.actions {
  display: flex;
  gap: 0.4rem;
}

button:disabled {
  opacity: 0.6;
  cursor: wait;
}

.error {
  margin: 0.5rem 0 0;
  font-size: 0.85rem;
  color: var(--color-error);
}
</style>
