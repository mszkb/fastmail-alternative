<script setup lang="ts">
// Password change (ADR-0004): needs the current password; on success the
// server ends all other devices/sessions and rotates this session's cookie.

const emit = defineEmits<{ changed: [] }>()

const currentPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const busy = ref(false)
const error = ref('')
const success = ref(false)

const MESSAGES: Record<number, string> = {
  400: 'Das neue Passwort muss 10 bis 200 Zeichen lang sein.',
  403: 'Das aktuelle Passwort ist falsch.',
  429: 'Zu viele Fehlversuche. Bitte später erneut versuchen.',
}

async function submit(): Promise<void> {
  if (busy.value) return
  error.value = ''
  success.value = false
  if (newPassword.value.length < 10 || newPassword.value.length > 200) {
    error.value = MESSAGES[400]!
    return
  }
  if (newPassword.value !== confirmPassword.value) {
    error.value = 'Die Bestätigung stimmt nicht mit dem neuen Passwort überein.'
    return
  }
  busy.value = true
  try {
    const res = await fetch('/api/auth/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        currentPassword: currentPassword.value,
        newPassword: newPassword.value,
      }),
    })
    if (res.status === 401) {
      notifyUnauthorized()
      return
    }
    if (!res.ok) {
      error.value = MESSAGES[res.status] ?? `Fehler ${res.status}`
      return
    }
    currentPassword.value = ''
    newPassword.value = ''
    confirmPassword.value = ''
    success.value = true
    emit('changed')
  } catch {
    error.value = 'API nicht erreichbar.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <form class="card" @submit.prevent="submit">
    <h2>Passwort ändern</h2>
    <p class="hint">Alle anderen Geräte werden dabei abgemeldet.</p>
    <label>
      Aktuelles Passwort
      <input v-model="currentPassword" type="password" autocomplete="current-password" required />
    </label>
    <label>
      Neues Passwort (mind. 10 Zeichen)
      <input
        v-model="newPassword"
        type="password"
        autocomplete="new-password"
        minlength="10"
        maxlength="200"
        required
      />
    </label>
    <label>
      Neues Passwort bestätigen
      <input
        v-model="confirmPassword"
        type="password"
        autocomplete="new-password"
        minlength="10"
        maxlength="200"
        required
      />
    </label>
    <button type="submit" :disabled="busy">Passwort ändern</button>
    <p v-if="success" class="ok">Passwort geändert. Andere Geräte wurden abgemeldet.</p>
    <p v-if="error" class="error">{{ error }}</p>
  </form>
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

label {
  display: block;
  margin-bottom: 0.75rem;
  font-size: 0.9rem;
}

input {
  display: block;
  width: 100%;
  box-sizing: border-box;
  margin-top: 0.25rem;
  padding: 0.5rem;
  border: 1px solid var(--fma-border);
  border-radius: 0.375rem;
  font: inherit;
}

button {
  padding: 0.5rem 1rem;
  border: 1px solid var(--color-primary);
  border-radius: 0.375rem;
  background: transparent;
  color: var(--color-primary);
  font: inherit;
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
