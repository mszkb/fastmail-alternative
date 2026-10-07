<script setup lang="ts">
// Service worker registration and update prompt (roadmap 4.1). The worker
// (/sw.js, built by scripts/build-sw.mjs) precaches the app shell only.
// A new version installs in the background and waits; the user decides when
// to switch ("Neu laden"), so an open draft is never lost by a forced
// reload. Not registered in development (Vite serves unhashed modules).
const updateReady = ref(false)
let registration: ServiceWorkerRegistration | null = null
let reloadRequested = false
let lastUpdateCheck = 0
const UPDATE_CHECK_MS = 10 * 60_000

function watchWorker(worker: ServiceWorker | null): void {
  if (!worker) return
  const check = (): void => {
    // 'installed' with an active controller = a new version is waiting
    // (the very first install has no controller and needs no prompt).
    if (worker.state === 'installed' && navigator.serviceWorker.controller) {
      updateReady.value = true
    }
  }
  check()
  worker.addEventListener('statechange', check)
}

/** Installed PWAs stay open for days: look for a new version when shown again. */
function onVisible(): void {
  if (document.visibilityState !== 'visible' || !registration) return
  if (Date.now() - lastUpdateCheck < UPDATE_CHECK_MS) return
  lastUpdateCheck = Date.now()
  registration.update().catch(() => {
    // offline: try again next time
  })
}

function reload(): void {
  const waiting = registration?.waiting
  if (!waiting) {
    window.location.reload()
    return
  }
  reloadRequested = true
  waiting.postMessage({ type: 'SKIP_WAITING' })
}

onMounted(async () => {
  if (import.meta.dev || !('serviceWorker' in navigator)) return
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // The new worker took over after "Neu laden": load the new shell once.
    // Takeovers triggered from another tab do not reload this one.
    if (!reloadRequested) return
    reloadRequested = false
    window.location.reload()
  })
  try {
    registration = await navigator.serviceWorker.register('/sw.js', {
      scope: '/',
      updateViaCache: 'none',
    })
    lastUpdateCheck = Date.now()
    watchWorker(registration.waiting)
    watchWorker(registration.installing)
    registration.addEventListener('updatefound', () => watchWorker(registration!.installing))
    document.addEventListener('visibilitychange', onVisible)
  } catch {
    // No service worker (e.g. private mode, plain HTTP): the app still works online.
  }
})

onBeforeUnmount(() => document.removeEventListener('visibilitychange', onVisible))
</script>

<template>
  <div v-if="updateReady" class="update" role="status">
    <span>Neue Version verfügbar</span>
    <button type="button" @click="reload">Neu laden</button>
    <button type="button" class="dismiss" aria-label="Später" @click="updateReady = false">
      ×
    </button>
  </div>
</template>

<style scoped>
.update {
  position: fixed;
  right: 1rem;
  bottom: calc(1rem + env(safe-area-inset-bottom));
  left: 1rem;
  z-index: 100;
  display: flex;
  align-items: center;
  gap: var(--fma-space-3);
  max-width: 24rem;
  margin: 0 auto;
  padding: 0.6rem var(--fma-space-3) 0.6rem var(--fma-space-4);
  border-radius: var(--fma-radius-box);
  background: var(--color-neutral);
  color: var(--color-neutral-content);
  font-family: system-ui, sans-serif;
  font-size: 0.9rem;
  box-shadow: 0 4px 16px rgb(0 0 0 / 25%);
}

.update span {
  flex: 1;
}

.update button {
  padding: 0.35rem 0.8rem;
  border: none;
  border-radius: var(--fma-radius);
  background: var(--color-primary);
  color: var(--color-primary-content);
  font: inherit;
  cursor: pointer;
}

.update button.dismiss {
  padding: 0.35rem var(--fma-space-2);
  background: transparent;
}
</style>
