<script setup lang="ts">
// Account list in the settings (roadmap 2.1/3.1): edit, signature, remove.
interface Account {
  id: string
  displayName: string
  emailAddress: string
  imap: { host: string; port: number }
  smtp: { host: string; port: number }
  status: string
  sortOrder?: number
}

defineProps<{ accounts: Account[] }>()
const emit = defineEmits<{ deleted: [id: string]; changed: [id: string] }>()

const busy = ref(false)
const error = ref('')
// Account whose signature editor is open.
const editing = ref('')
// Account whose edit form is open (also opened from the mail view, e.g.
// "Zugangsdaten aktualisieren").
const editingAccount = defineModel<string>('edit', { default: '' })

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
          <span class="tag">{{ account.status }}</span>
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
            Signatur
          </button>
          <button type="button" :disabled="busy" @click="remove(account)">Entfernen</button>
        </span>
        <AccountForm
          v-if="editingAccount === account.id"
          :account="account"
          @saved="onSaved(account.id)"
          @cancel="editingAccount = ''"
        />
        <IdentitySignatures v-if="editing === account.id" :account-id="account.id" />
      </li>
    </ul>
    <p v-if="error" class="error">{{ error }}</p>
  </div>
</template>

<style scoped>
.card {
  padding: 1rem 1.25rem;
  margin-bottom: 1rem;
  border: 1px solid #d5dde5;
  border-radius: 0.5rem;
  background: #f7f9fb;
}

h2 {
  margin: 0 0 0.5rem;
  font-size: 1.1rem;
}

.hint {
  margin: 0;
  font-size: 0.85rem;
  color: #52606d;
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
  border-bottom: 1px solid #e4e9ee;
}

.accounts li:last-child {
  border-bottom: none;
}

.mail {
  display: block;
  font-size: 0.8rem;
  color: #52606d;
}

.tag {
  display: inline-block;
  margin-left: 0.4rem;
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  background: #d9f2e4;
  font-size: 0.75rem;
  color: #147d46;
}

button {
  padding: 0.4rem 0.8rem;
  border: 1px solid #cf1124;
  border-radius: 0.375rem;
  background: transparent;
  color: #cf1124;
  font: inherit;
  cursor: pointer;
}

button.neutral {
  border-color: #1273de;
  color: #1273de;
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
  color: #9b1c1c;
}
</style>
