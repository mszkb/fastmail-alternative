<script setup lang="ts">
// Install banner (roadmap 4.2): shown in a browser tab (not in the
// installed app) where installing is possible; "Später" hides it for 30
// days in this browser. "Anleitung" opens the guide in the settings.
import { shouldShowInstallBanner, type InstallPlatform } from '@fma/shared'

const emit = defineEmits<{ guide: [] }>()

const visible = ref(false)
const platform = ref<InstallPlatform>('other')

function refresh(): void {
  visible.value =
    !appInstalled.value &&
    shouldShowInstallBanner({
      platform: platform.value,
      standalone: isStandalone(),
      dismissedAt: installDismissedAt(),
      now: Date.now(),
    })
}

function later(): void {
  dismissInstallBanner()
  visible.value = false
}

async function install(): Promise<void> {
  if (await promptInstall()) visible.value = false
}

watch(appInstalled, refresh)

onMounted(() => {
  platform.value = currentInstallPlatform()
  refresh()
})
</script>

<template>
  <div v-if="visible" class="banner" role="region" aria-label="App installieren">
    <span v-if="platform === 'ios-other'">
      Als App installieren: diese Seite in Safari öffnen und „Zum Home-Bildschirm“ wählen.
    </span>
    <span v-else-if="platform === 'ios-safari'">
      Als App installieren (Teilen → „Zum Home-Bildschirm“) – nur dann gibt es Benachrichtigungen.
    </span>
    <span v-else>Als App installieren – schnellerer Start im eigenen Fenster.</span>
    <span class="actions">
      <button v-if="installPrompt" type="button" @click="install">Installieren</button>
      <button type="button" class="secondary" @click="emit('guide')">Anleitung</button>
      <button type="button" class="secondary" @click="later">Später</button>
    </span>
  </div>
</template>

<style scoped>
.banner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--fma-space-2);
  padding: 0.6rem 0.9rem;
  margin-bottom: var(--fma-space-4);
  border: 1px solid var(--fma-primary-soft);
  border-radius: var(--fma-radius-box);
  background: var(--fma-primary-soft);
  font-size: 0.9rem;
  color: var(--color-base-content);
}

.actions {
  display: flex;
  gap: 0.4rem;
}

button {
  padding: 0.35rem 0.8rem;
  border: 1px solid var(--color-primary);
  border-radius: var(--fma-radius);
  background: var(--color-primary);
  color: var(--color-primary-content);
  font: inherit;
  cursor: pointer;
}

button.secondary {
  background: transparent;
  color: var(--color-primary);
}
</style>
