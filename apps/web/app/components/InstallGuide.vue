<script setup lang="ts">
// Install guide per platform (roadmap 4.2): the matching guide for this
// browser first, the others collapsed below (e.g. to set up a second
// device). Chromium browsers get an "App installieren" button when the
// native dialog is available.
import { canInstall, type InstallPlatform } from '@fma/shared'

interface Guide {
  title: string
  steps: string[]
  note?: string
}

const GUIDES: Record<Exclude<InstallPlatform, 'other'>, Guide> = {
  'ios-safari': {
    title: 'iPhone und iPad (Safari)',
    steps: [
      'Unten (iPad: oben) auf das Teilen-Symbol tippen (Quadrat mit Pfeil nach oben).',
      'Im Menü „Zum Home-Bildschirm“ wählen – ggf. nach unten scrollen.',
      '„Hinzufügen“ antippen und die App künftig über das Symbol auf dem Home-Bildschirm öffnen.',
    ],
    note: 'Nur in der installierten App sind Benachrichtigungen und das App-Badge möglich (ab iOS 16.4).',
  },
  'ios-other': {
    title: 'iPhone und iPad (anderer Browser)',
    steps: [
      'Diese Seite in Safari öffnen (Adresse kopieren oder „In Safari öffnen“ wählen).',
      'Dort im Teilen-Menü „Zum Home-Bildschirm“ wählen.',
    ],
    note: 'In In-App-Browsern (z. B. aus Messenger-Apps) lässt sich die App nicht installieren.',
  },
  'android-chromium': {
    title: 'Android (Chrome, Edge, Samsung Internet)',
    steps: [
      '„App installieren“ antippen – oder im Browsermenü (⋮) „App installieren“ bzw. „Zum Startbildschirm hinzufügen“ wählen.',
      'Bestätigen; die App erscheint im App-Drawer und auf dem Startbildschirm.',
    ],
  },
  'android-firefox': {
    title: 'Android (Firefox)',
    steps: [
      'Im Browsermenü (⋮) „Installieren“ bzw. „Zum Startbildschirm hinzufügen“ wählen.',
      'Für Benachrichtigungen im Hintergrund ist Chrome zuverlässiger.',
    ],
  },
  'android-other': {
    title: 'Android (anderer Browser)',
    steps: ['Diese Seite in Chrome öffnen und dort „App installieren“ wählen.'],
  },
  'desktop-chromium': {
    title: 'Computer (Chrome, Edge)',
    steps: [
      '„App installieren“ klicken – oder das Installieren-Symbol rechts in der Adressleiste.',
      'Alternativ im Browsermenü „App installieren“ bzw. „Apps → Diese Website als App installieren“.',
      'Die App startet danach in einem eigenen Fenster und über Startmenü/Dock.',
    ],
  },
  'desktop-safari': {
    title: 'Mac (Safari)',
    steps: [
      'In der Menüleiste „Ablage → Zum Dock hinzufügen“ wählen (ab macOS Sonoma).',
      'Die App startet danach in einem eigenen Fenster aus dem Dock.',
    ],
  },
  'desktop-firefox': {
    title: 'Computer (Firefox)',
    steps: [
      'Firefox kann Web-Apps nicht installieren. Die Seite als Lesezeichen anheften oder zum Installieren Chrome bzw. Edge verwenden.',
    ],
  },
}

const platform = ref<InstallPlatform>('other')
const standalone = ref(false)
const busy = ref(false)

const own = computed(() => (platform.value === 'other' ? null : GUIDES[platform.value]))
const others = computed(() =>
  (Object.keys(GUIDES) as (keyof typeof GUIDES)[]).filter((key) => key !== platform.value),
)

async function install(): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    await promptInstall()
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  platform.value = currentInstallPlatform()
  standalone.value = isStandalone()
})
</script>

<template>
  <div id="install" class="card install">
    <h2>App installieren</h2>
    <p v-if="standalone || appInstalled" class="ok">
      Die App ist auf diesem Gerät installiert und läuft im eigenen Fenster.
    </p>
    <template v-else>
      <p class="hint">
        Installiert startet die App schneller, läuft im eigenen Fenster und kann (auf iPhone/iPad
        nur so) Benachrichtigungen und ein App-Badge anzeigen.
      </p>
      <button v-if="installPrompt" type="button" :disabled="busy" @click="install">
        App installieren
      </button>
      <div v-if="own" class="guide">
        <h3>{{ own.title }}</h3>
        <ol>
          <li v-for="step in own.steps" :key="step">{{ step }}</li>
        </ol>
        <p v-if="own.note" class="hint">{{ own.note }}</p>
      </div>
      <p v-else-if="!canInstall(platform)" class="hint">
        Für diesen Browser gibt es keine Installationsanleitung. Die Anleitungen für andere Geräte
        stehen unten.
      </p>
    </template>
    <details>
      <summary>Anleitungen für andere Geräte</summary>
      <div v-for="key in others" :key="key" class="guide">
        <h3>{{ GUIDES[key].title }}</h3>
        <ol>
          <li v-for="step in GUIDES[key].steps" :key="step">{{ step }}</li>
        </ol>
        <p v-if="GUIDES[key].note" class="hint">{{ GUIDES[key].note }}</p>
      </div>
    </details>
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

h3 {
  margin: 0.75rem 0 0.25rem;
  font-size: 0.95rem;
}

ol {
  margin: 0;
  padding-left: 1.25rem;
  font-size: 0.9rem;
}

li {
  margin-bottom: 0.25rem;
}

.hint {
  margin: 0.25rem 0 0.5rem;
  font-size: 0.85rem;
  color: var(--fma-muted);
}

.ok {
  margin: 0 0 0.5rem;
  font-size: 0.9rem;
  color: var(--color-success);
}

details {
  margin-top: 0.75rem;
  font-size: 0.9rem;
}

summary {
  cursor: pointer;
  color: var(--color-primary);
}

button {
  padding: 0.5rem 1rem;
  border: none;
  border-radius: 0.375rem;
  background: var(--color-primary);
  color: var(--color-primary-content);
  font: inherit;
  cursor: pointer;
}

button:disabled {
  opacity: 0.6;
  cursor: wait;
}
</style>
