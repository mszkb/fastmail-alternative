<script setup lang="ts">
// Configuration export/import (roadmap 4.7, docs/operations/migration.md):
// the file holds accounts, identities and folder mappings, but no
// passwords - imported accounts ask for them before the first sync.
import type { ConfigImportResponse } from '@fma/shared'

const emit = defineEmits<{ imported: [] }>()

const busy = ref(false)
const error = ref('')
const result = ref<ConfigImportResponse | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)

async function importFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || busy.value) return
  busy.value = true
  error.value = ''
  result.value = null
  try {
    let body: unknown
    try {
      body = JSON.parse(await file.text())
    } catch {
      error.value = 'Die Datei ist keine gültige JSON-Datei.'
      return
    }
    const res = await fetch('/api/import/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = (await res.json().catch(() => null)) as
      (ConfigImportResponse & { message?: string }) | null
    if (!res.ok || !json) {
      error.value = json?.message ?? `Fehler ${res.status}`
      return
    }
    result.value = json
    if (json.imported.length > 0) emit('imported')
  } catch {
    error.value = 'API nicht erreichbar.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="card">
    <h2>Konfiguration übertragen</h2>
    <p class="hint">
      Konten (Server, Ports, Benutzernamen), Identitäten mit Signaturen und Ordnerzuordnungen als
      Datei sichern, z. B. für den Umzug auf einen neuen Server. Passwörter und Nachrichten sind
      nicht enthalten: Nach dem Import wird je Konto das Passwort neu abgefragt, die Nachrichten
      werden vom Mailanbieter neu abgeglichen.
    </p>
    <div class="row">
      <a class="button" href="/api/export/config" download>Exportieren</a>
      <button type="button" :disabled="busy" @click="fileInput?.click()">Importieren …</button>
      <input
        ref="fileInput"
        type="file"
        accept="application/json,.json"
        hidden
        @change="importFile"
      />
    </div>
    <p v-if="result" class="ok">
      {{ result.imported.length }} Konto/Konten importiert<template v-if="result.skipped.length"
        >, {{ result.skipped.length }} bereits vorhanden (übersprungen)</template
      >.
      <template v-if="result.imported.length">
        Bitte unter „Konten“ bei jedem importierten Konto „Bearbeiten“ wählen und das Passwort
        eingeben.
      </template>
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
  margin: 0 0 0.25rem;
  font-size: 1.1rem;
}

.hint {
  margin: 0 0 0.75rem;
  font-size: 0.85rem;
  color: var(--fma-muted);
}

.row {
  display: flex;
  gap: 0.5rem;
}

button,
a.button {
  display: inline-block;
  padding: 0.5rem 1rem;
  border: 1px solid var(--color-primary);
  border-radius: 0.375rem;
  background: transparent;
  color: var(--color-primary);
  font: inherit;
  text-decoration: none;
  cursor: pointer;
}

button:disabled {
  opacity: 0.6;
  cursor: wait;
}

.ok {
  margin: 0.75rem 0 0;
  font-size: 0.9rem;
  color: var(--color-success);
}

.error {
  margin: 0.75rem 0 0;
  font-size: 0.85rem;
  color: var(--color-error);
}
</style>
