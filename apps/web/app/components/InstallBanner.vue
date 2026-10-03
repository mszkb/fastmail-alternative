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
  gap: 0.5rem;
  padding: 0.6rem 0.9rem;
  margin-bottom: 1rem;
  border: 1px solid #b6d4f5;
  border-radius: 0.5rem;
  background: #eaf3fd;
  font-size: 0.9rem;
  color: #1f2933;
}

.actions {
  display: flex;
  gap: 0.4rem;
}

button {
  padding: 0.35rem 0.8rem;
  border: 1px solid #1273de;
  border-radius: 0.375rem;
  background: #1273de;
  color: #fff;
  font: inherit;
  cursor: pointer;
}

button.secondary {
  background: transparent;
  color: #1273de;
}
</style>
