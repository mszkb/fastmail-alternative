<script setup lang="ts">
// First steps (#117): a short checklist after the first setup - add an
// account (with provider presets, e.g. Fastmail with an app password),
// switch on notifications, install the app, learn the keyboard shortcuts.
// Shown while no account exists and in the settings until dismissed (per
// device).
import {
  IconBell,
  IconCheck,
  IconDeviceMobile,
  IconKeyboard,
  IconMailPlus,
} from '@tabler/icons-vue'

const props = defineProps<{ hasAccounts: boolean }>()
const emit = defineEmits<{
  addAccount: []
  open: [section: 'push' | 'install']
  shortcuts: []
}>()

const DISMISSED_KEY = 'fma.gettingStarted.dismissed'
const dismissed = ref(readDismissed())

function readDismissed(): boolean {
  try {
    return import.meta.client && localStorage.getItem(DISMISSED_KEY) === '1'
  } catch {
    return false
  }
}

function dismiss(): void {
  dismissed.value = true
  try {
    localStorage.setItem(DISMISSED_KEY, '1')
  } catch {
    // Private mode: hidden for this session only.
  }
}

const visible = computed(() => !props.hasAccounts || !dismissed.value)
</script>

<template>
  <section v-if="visible" class="card getting-started" aria-labelledby="getting-started-title">
    <div class="head">
      <h2 id="getting-started-title">Erste Schritte</h2>
      <button v-if="hasAccounts" type="button" class="link" @click="dismiss">Ausblenden</button>
    </div>
    <ol>
      <li :class="{ done: hasAccounts }">
        <span class="icon" aria-hidden="true">
          <IconCheck v-if="hasAccounts" :size="18" />
          <IconMailPlus v-else :size="18" />
        </span>
        <span class="text">
          <strong>Konto hinzufügen</strong>
          <span
            >Bestehende Konten per IMAP/SMTP verbinden. Für bekannte Anbieter (z. B. Fastmail,
            Posteo, Gmail) füllt eine Vorlage Server und Ports aus; Fastmail und Gmail brauchen ein
            App-Passwort.</span
          >
        </span>
        <button v-if="!hasAccounts" type="button" @click="emit('addAccount')">
          Konto hinzufügen
        </button>
        <span v-else class="sr-only">erledigt</span>
      </li>
      <li>
        <span class="icon" aria-hidden="true"><IconBell :size="18" /></span>
        <span class="text">
          <strong>Benachrichtigungen</strong>
          <span>Pro Gerät einschalten; sie enthalten nie Betreff oder Absender.</span>
        </span>
        <button type="button" class="secondary" @click="emit('open', 'push')">Öffnen</button>
      </li>
      <li>
        <span class="icon" aria-hidden="true"><IconDeviceMobile :size="18" /></span>
        <span class="text">
          <strong>Als App installieren</strong>
          <span
            >Startet schneller im eigenen Fenster; auf dem iPhone nötig für
            Benachrichtigungen.</span
          >
        </span>
        <button type="button" class="secondary" @click="emit('open', 'install')">Anleitung</button>
      </li>
      <li>
        <span class="icon" aria-hidden="true"><IconKeyboard :size="18" /></span>
        <span class="text">
          <strong>Tastenkürzel</strong>
          <span>Mit <kbd>?</kbd> jederzeit die Übersicht öffnen.</span>
        </span>
        <button type="button" class="secondary" @click="emit('shortcuts')">Anzeigen</button>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.getting-started {
  margin-bottom: var(--fma-space-4);
  padding: var(--fma-space-4) 1.25rem;
  border: 1px solid var(--fma-border);
  border-radius: var(--fma-radius-box);
  background: var(--color-base-200);
}

.head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}

.head h2 {
  margin: 0 0 var(--fma-space-2);
}

ol {
  margin: 0;
  padding: 0;
  list-style: none;
}

li {
  display: flex;
  align-items: center;
  gap: var(--fma-space-3);
  padding: 0.6rem 0;
  border-top: 1px solid var(--fma-border);
}

.icon {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  border-radius: 50%;
  background: var(--fma-primary-soft);
  color: var(--color-primary);
}

li.done .icon {
  background: var(--fma-success-soft);
  color: var(--color-success);
}

.text {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  font-size: var(--fma-text-sm);
  color: var(--fma-muted);
}

.text strong {
  color: var(--color-base-content);
  font-size: var(--fma-text-md);
}

li.done strong {
  text-decoration: line-through;
}

button {
  flex-shrink: 0;
  padding: 0.35rem var(--fma-space-3);
  border: 1px solid var(--color-primary);
  border-radius: var(--fma-radius);
  background: var(--color-primary);
  color: var(--color-primary-content);
  font: inherit;
  font-size: var(--fma-text-sm);
}

button.secondary {
  background: transparent;
  color: var(--color-primary);
}

button.link {
  padding: 0;
  border: none;
  background: transparent;
  color: var(--color-primary);
}

kbd {
  padding: 0 0.3rem;
  border: 1px solid var(--fma-border-strong);
  border-radius: 0.25rem;
  font-family: ui-monospace, monospace;
  font-size: 0.8rem;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}

@media (max-width: 520px) {
  li {
    flex-wrap: wrap;
  }

  li button {
    margin-left: 2.75rem;
  }
}
</style>
