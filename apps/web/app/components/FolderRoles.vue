<script setup lang="ts">
// Folder mapping per account (roadmap 3.3): which folder is used for sent
// copies, drafts, trash, archive and spam. "Automatisch" uses SPECIAL-USE or
// the folder name; a manual choice survives every sync.
import {
  FOLDER_ROLES,
  FOLDER_ROLE_LABELS,
  type FolderListResponse,
  type FolderRole,
  type FolderSummary,
} from '@fma/shared'

const props = defineProps<{ accountId: string }>()

const folders = ref<FolderSummary[]>([])
const loading = ref(true)
const saving = ref(false)
const error = ref('')

const AUTO = ''

/** Folder currently used for a role and whether it was chosen manually. */
function current(role: FolderRole): FolderSummary | undefined {
  return folders.value.find((f) => f.specialUse === role)
}

function selected(role: FolderRole): string {
  return folders.value.find((f) => f.specialUseOverride === role)?.id ?? AUTO
}

function autoLabel(role: FolderRole): string {
  if (selected(role) !== AUTO) return 'Automatisch'
  const detected = current(role)
  return detected ? `Automatisch (${detected.path})` : 'Automatisch (nicht erkannt)'
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const res = await fetch(`/api/accounts/${props.accountId}/folders`)
    if (!res.ok) throw new Error()
    folders.value = ((await res.json()) as FolderListResponse).folders
  } catch {
    error.value = 'Ordner konnten nicht geladen werden.'
  } finally {
    loading.value = false
  }
}

async function patch(folderId: string, specialUse: FolderRole | null): Promise<boolean> {
  const res = await fetch(`/api/folders/${folderId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ specialUse }),
  })
  if (res.ok) return true
  const body = (await res.json().catch(() => null)) as { message?: string } | null
  error.value = body?.message ?? `Fehler ${res.status}`
  return false
}

async function change(role: FolderRole, event: Event): Promise<void> {
  const folderId = (event.target as HTMLSelectElement).value
  if (saving.value) return
  saving.value = true
  error.value = ''
  try {
    const previous = selected(role)
    const ok =
      folderId === AUTO
        ? previous === AUTO || (await patch(previous, null))
        : await patch(folderId, role)
    if (ok) await load()
  } catch {
    error.value = 'API nicht erreichbar.'
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="roles">
    <p v-if="loading" class="hint">Wird geladen &hellip;</p>
    <template v-else>
      <label v-for="role in FOLDER_ROLES" :key="role">
        <span>{{ FOLDER_ROLE_LABELS[role] }}</span>
        <select :value="selected(role)" :disabled="saving" @change="change(role, $event)">
          <option :value="AUTO">{{ autoLabel(role) }}</option>
          <option
            v-for="folder in folders.filter(
              (f) => f.selectable && f.path.toUpperCase() !== 'INBOX',
            )"
            :key="folder.id"
            :value="folder.id"
          >
            {{ folder.path }}
          </option>
        </select>
      </label>
      <p class="hint">
        Archivieren, Löschen und die Kopie gesendeter Nachrichten nutzen diese Ordner. Eine eigene
        Auswahl bleibt bei jeder Synchronisierung erhalten.
      </p>
    </template>
    <p v-if="error" class="error">{{ error }}</p>
  </div>
</template>

<style scoped>
.roles {
  flex-basis: 100%;
  padding: 0.5rem 0 0.25rem;
}

label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
  font-size: 0.85rem;
}

label span {
  flex: 0 0 6rem;
}

select {
  flex: 1;
  min-width: 0;
  padding: 0.35rem;
  border: 1px solid #b8c2cc;
  border-radius: 0.375rem;
  font: inherit;
  font-size: 0.85rem;
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
