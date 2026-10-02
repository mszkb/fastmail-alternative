<script setup lang="ts">
// Auth UI (roadmap 1.6): first-start setup, login, logout and device
// management. The real mail UI replaces the "app" view in later phases.
interface AuthStatus {
  needsSetup: boolean
  authenticated: boolean
  email?: string
}

interface DeviceInfo {
  id: string
  name: string
  platform: string
  lastSeenAt: string | null
  isCurrent: boolean
}

const view = ref<'loading' | 'setup' | 'login' | 'app'>('loading')
const email = ref('')
const password = ref('')
const deviceName = ref('')
const busy = ref(false)
const error = ref('')
const info = ref('')
const currentEmail = ref('')
const devices = ref<DeviceInfo[]>([])

function guessPlatform(): string {
  const ua = navigator.userAgent
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios_pwa'
  if (/Android/i.test(ua)) return 'android_pwa'
  return 'desktop'
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...options,
    headers: {
      // Only send a content-type when there is a body; Fastify rejects empty
      // JSON bodies otherwise (broke DELETE logout/revocation before).
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    },
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null
    throw new Error(body?.message ?? `Fehler ${res.status}`)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

async function loadStatus(): Promise<void> {
  try {
    const status = await api<AuthStatus>('/api/auth/status')
    if (status.needsSetup) {
      view.value = 'setup'
    } else if (status.authenticated) {
      currentEmail.value = status.email ?? ''
      view.value = 'app'
      await loadDevices()
    } else {
      view.value = 'login'
    }
  } catch {
    error.value = 'API nicht erreichbar'
    view.value = 'login'
  }
}

async function submit(): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = ''
  info.value = ''
  const path = view.value === 'setup' ? '/api/auth/setup' : '/api/auth/login'
  try {
    const res = await api<{ email: string }>(path, {
      method: 'POST',
      body: JSON.stringify({
        email: email.value,
        password: password.value,
        deviceName: deviceName.value || undefined,
        platform: guessPlatform(),
      }),
    })
    currentEmail.value = res.email
    password.value = ''
    view.value = 'app'
    await loadDevices()
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Unbekannter Fehler'
  } finally {
    busy.value = false
  }
}

async function loadDevices(): Promise<void> {
  try {
    const res = await api<{ devices: DeviceInfo[] }>('/api/auth/devices')
    devices.value = res.devices
  } catch {
    devices.value = []
  }
}

async function revokeDevice(device: DeviceInfo): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    await api(`/api/auth/devices/${device.id}`, { method: 'DELETE' })
    info.value = `„${device.name}“ wurde abgemeldet.`
    await loadDevices()
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Unbekannter Fehler'
  } finally {
    busy.value = false
  }
}

async function logout(): Promise<void> {
  await api('/api/auth/session', { method: 'DELETE' }).catch(() => {})
  email.value = ''
  password.value = ''
  devices.value = []
  currentEmail.value = ''
  info.value = ''
  await loadStatus()
}

onMounted(loadStatus)
</script>

<template>
  <main class="shell">
    <h1>fastmail-alternative</h1>

    <div v-if="view === 'loading'" class="card">Wird geladen &hellip;</div>

    <!-- First start: create the single user -->
    <form v-else-if="view === 'setup'" class="card form" @submit.prevent="submit">
      <h2>Einrichtung</h2>
      <p class="hint">Ersten Benutzer anlegen (Single-User-Instanz, ADR-0004).</p>
      <label>E-Mail<input v-model="email" type="email" autocomplete="username" required /></label>
      <label
        >Passwort (min. 10 Zeichen)<input
          v-model="password"
          type="password"
          autocomplete="new-password"
          minlength="10"
          required
      /></label>
      <label
        >Gerätename (optional)<input v-model="deviceName" type="text" placeholder="z. B. MacBook"
      /></label>
      <button type="submit" :disabled="busy">Konto erstellen</button>
    </form>

    <!-- Login -->
    <form v-else-if="view === 'login'" class="card form" @submit.prevent="submit">
      <h2>Anmeldung</h2>
      <label>E-Mail<input v-model="email" type="email" autocomplete="username" required /></label>
      <label
        >Passwort<input v-model="password" type="password" autocomplete="current-password" required
      /></label>
      <label
        >Gerätename (optional)<input v-model="deviceName" type="text" placeholder="z. B. iPhone"
      /></label>
      <button type="submit" :disabled="busy">Anmelden</button>
    </form>

    <!-- Authenticated placeholder "app" -->
    <template v-else>
      <div class="card">
        <p>
          Angemeldet als <strong>{{ currentEmail }}</strong>
        </p>
        <button type="button" :disabled="busy" @click="logout">Abmelden</button>
      </div>

      <div class="card">
        <h2>Geräte</h2>
        <p class="hint">Ein Gerät abzumelden beendet alle zugehörigen Sitzungen.</p>
        <ul class="devices">
          <li v-for="device in devices" :key="device.id">
            <span>
              <strong>{{ device.name }}</strong>
              <span class="tag">{{ device.platform }}</span>
              <span v-if="device.isCurrent" class="tag current">dieses Gerät</span>
            </span>
            <button
              v-if="!device.isCurrent"
              type="button"
              :disabled="busy"
              @click="revokeDevice(device)"
            >
              Abmelden
            </button>
          </li>
        </ul>
      </div>
    </template>

    <p v-if="error" class="message error">{{ error }}</p>
    <p v-else-if="info" class="message info">{{ info }}</p>
  </main>
</template>

<style scoped>
.shell {
  max-width: 28rem;
  margin: 3rem auto;
  padding: 0 1rem;
  font-family: system-ui, sans-serif;
  color: #1f2933;
}

.card {
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

.form label {
  display: block;
  margin-bottom: 0.75rem;
  font-size: 0.9rem;
}

.form input {
  display: block;
  width: 100%;
  margin-top: 0.25rem;
  padding: 0.5rem;
  border: 1px solid #b8c2cc;
  border-radius: 0.375rem;
  box-sizing: border-box;
  font: inherit;
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

.devices {
  list-style: none;
  margin: 0;
  padding: 0;
}

.devices li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.5rem 0;
  border-bottom: 1px solid #e4e9ee;
}

.devices li:last-child {
  border-bottom: none;
}

.tag {
  display: inline-block;
  margin-left: 0.4rem;
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  background: #e4e9ee;
  font-size: 0.75rem;
  color: #3e4c59;
}

.tag.current {
  background: #d9f2e4;
  color: #147d46;
}

.message {
  padding: 0.75rem 1rem;
  border-radius: 0.375rem;
  font-size: 0.9rem;
}

.message.error {
  background: #fde8e8;
  color: #9b1c1c;
}

.message.info {
  background: #def7ec;
  color: #046c4e;
}
</style>
