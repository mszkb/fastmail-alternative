<script setup lang="ts">
// Placeholder app shell; the real UI is built in phases 2/3.
const apiStatus = ref<'checking' | 'ok' | 'down'>('checking')

onMounted(async () => {
  try {
    const res = await fetch('/api/health')
    apiStatus.value = res.ok ? 'ok' : 'down'
  } catch {
    apiStatus.value = 'down'
  }
})
</script>

<template>
  <main class="shell">
    <h1>fastmail-alternative</h1>
    <p class="subtitle">Self-hosted multi-account mail client</p>

    <div class="card">
      <span class="dot" :class="apiStatus" />
      <span v-if="apiStatus === 'checking'">API wird geprüft &hellip;</span>
      <span v-else-if="apiStatus === 'ok'">API erreichbar</span>
      <span v-else>API nicht erreichbar</span>
    </div>

    <p class="note">
      Phase-1-Skeleton &ndash; UI, Login und Mail-Funktionen folgen in den n&auml;chsten Phasen.
    </p>
  </main>
</template>

<style scoped>
.shell {
  max-width: 32rem;
  margin: 4rem auto;
  padding: 0 1rem;
  font-family: system-ui, sans-serif;
  color: #1f2933;
}

.subtitle {
  color: #52606d;
}

.card {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 1rem 1.25rem;
  border: 1px solid #d5dde5;
  border-radius: 0.5rem;
  background: #f7f9fb;
}

.dot {
  width: 0.75rem;
  height: 0.75rem;
  border-radius: 50%;
  background: #9aa5b1;
}

.dot.ok {
  background: #2fbf71;
}

.dot.down {
  background: #e5484d;
}

.note {
  margin-top: 1.5rem;
  font-size: 0.875rem;
  color: #52606d;
}
</style>
