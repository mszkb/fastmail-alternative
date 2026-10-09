<script setup lang="ts">
// App header (#120): one bar across the full width. Left the product name
// with our own mark (no logos of other products), in the middle the search
// - across all accounts (#121, GlobalSearch) -, on the right the
// offline/queue state, help with the
// keyboard shortcuts and the profile menu (settings, logout).
// Small screens: a menu button opens the side menu with the accounts, and
// the search icon opens the search as a full-screen layer.
import { SHORTCUTS, shortcutLabel } from '@fma/shared'
import { IconHelp, IconMail, IconMenu2, IconSearch, IconX } from '@tabler/icons-vue'
import { isTypingTarget, shortcutsEnabled } from '~/utils/shortcuts-setting'

const props = defineProps<{
  email: string
  searchPlaceholder: string
  /** Search disabled (no account, or offline: IMAP SEARCH needs the server). */
  searchDisabled?: boolean
  menuOpen?: boolean
}>()
const emit = defineEmits<{
  search: [query: string]
  toggleMenu: []
  settings: []
  logout: []
}>()

const query = ref('')
const searchOpen = ref(false)
const helpOpen = ref(false)
const searchInput = ref<HTMLInputElement | null>(null)
const mobileInput = ref<HTMLInputElement | null>(null)
const helpButton = ref<HTMLButtonElement | null>(null)

/** Overview (?): the shortcut table of @fma/shared plus the app-wide keys. */
const SHORTCUT_GROUPS = computed(() => {
  const groups = new Map<string, { keys: string[]; label: string }[]>()
  for (const shortcut of SHORTCUTS) {
    const list = groups.get(shortcut.group) ?? []
    list.push({ keys: shortcut.keys.map(shortcutLabel), label: shortcut.label })
    groups.set(shortcut.group, list)
  }
  groups
    .get('Allgemein')
    ?.push(
      { keys: ['1 … 9'], label: 'Konto wechseln (Strg+1 … 9 in der installierten App)' },
      { keys: ['Alt+↑', 'Alt+↓'], label: 'Konto in der Leiste verschieben' },
    )
  return [...groups.entries()]
})

function submit(): void {
  const q = query.value.trim()
  if (!q || props.searchDisabled) return
  emit('search', q)
  searchOpen.value = false
}

async function openSearch(): Promise<void> {
  searchOpen.value = true
  await nextTick()
  mobileInput.value?.focus()
}

function closeHelp(): void {
  helpOpen.value = false
  helpButton.value?.focus()
}

/** "/" focuses the search (outside of input fields). */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && helpOpen.value) {
    event.preventDefault()
    closeHelp()
    return
  }
  if (!shortcutsEnabled.value || event.ctrlKey || event.metaKey || event.altKey) return
  if (event.key !== '/' && event.key !== '?') return
  if (isTypingTarget(event.target)) return
  if ((event.target as HTMLElement | null)?.closest?.('[role="dialog"]')) return
  event.preventDefault()
  if (event.key === '?') {
    helpOpen.value = !helpOpen.value
    return
  }
  if (searchInput.value && searchInput.value.offsetParent !== null) searchInput.value.focus()
  else void openSearch()
}

/** Opens the keyboard help (e.g. from the first steps). */
function openHelp(): void {
  helpOpen.value = true
}

defineExpose({ openHelp })

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <header class="app-header">
    <button
      type="button"
      class="icon-button menu-button"
      aria-label="Konten und Ordner"
      :aria-expanded="menuOpen ? 'true' : 'false'"
      aria-controls="side-menu"
      @click="emit('toggleMenu')"
    >
      <IconMenu2 :size="22" aria-hidden="true" />
    </button>
    <span class="brand">
      <span class="mark" aria-hidden="true"><IconMail :size="18" stroke-width="2" /></span>
      <span class="brand-name">Mail</span>
    </span>

    <form class="search" role="search" @submit.prevent="submit">
      <IconSearch class="search-icon" :size="18" aria-hidden="true" />
      <input
        ref="searchInput"
        v-model="query"
        type="search"
        enterkeyhint="search"
        aria-label="Suchbegriff"
        :placeholder="searchPlaceholder"
        :disabled="searchDisabled"
      />
    </form>

    <span class="actions">
      <slot name="status" />
      <button
        type="button"
        class="icon-button search-button"
        aria-label="Suche öffnen"
        :disabled="searchDisabled"
        @click="openSearch"
      >
        <IconSearch :size="22" aria-hidden="true" />
      </button>
      <button
        ref="helpButton"
        type="button"
        class="icon-button"
        aria-label="Hilfe"
        aria-haspopup="dialog"
        :aria-expanded="helpOpen ? 'true' : 'false'"
        @click="helpOpen = !helpOpen"
      >
        <IconHelp :size="22" aria-hidden="true" />
      </button>
      <ProfileMenu :email="email" @settings="emit('settings')" @logout="emit('logout')" />
    </span>

    <!-- Small screens: full-screen search -->
    <div v-if="searchOpen" class="search-layer" role="dialog" aria-label="Suche">
      <form class="search-layer-form" role="search" @submit.prevent="submit">
        <input
          ref="mobileInput"
          v-model="query"
          type="search"
          enterkeyhint="search"
          aria-label="Suchbegriff"
          :placeholder="searchPlaceholder"
          @keydown.esc.prevent="searchOpen = false"
        />
        <button
          type="button"
          class="icon-button"
          aria-label="Suche schließen"
          @click="searchOpen = false"
        >
          <IconX :size="22" aria-hidden="true" />
        </button>
      </form>
      <p class="hint">Durchsucht das aktive Konto beim Anbieter (nur online).</p>
    </div>

    <div v-if="helpOpen" class="help-panel" role="dialog" aria-label="Tastenkürzel">
      <div class="help-head">
        <h2>Tastenkürzel</h2>
        <button type="button" class="icon-button" aria-label="Schließen" @click="closeHelp">
          <IconX :size="20" aria-hidden="true" />
        </button>
      </div>
      <p v-if="!shortcutsEnabled" class="hint">
        Tastenkürzel sind auf diesem Gerät ausgeschaltet (Einstellungen → Tastenkürzel).
      </p>
      <section v-for="[group, entries] in SHORTCUT_GROUPS" :key="group">
        <h3>{{ group }}</h3>
        <dl>
          <template v-for="entry in entries" :key="entry.label">
            <dt>
              <template v-for="(key, index) in entry.keys" :key="key">
                <span v-if="index > 0"> / </span><kbd>{{ key }}</kbd>
              </template>
            </dt>
            <dd>{{ entry.label }}</dd>
          </template>
        </dl>
      </section>
    </div>
  </header>
</template>

<style scoped>
.app-header {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--fma-space-3);
  min-height: 3.25rem;
  padding: 0.4rem var(--fma-space-3);
  border-bottom: 1px solid var(--fma-border);
  background: var(--color-base-100);
}

.brand {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  flex-shrink: 0;
  min-width: 3.25rem;
  font-weight: 700;
}

.mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.9rem;
  height: 1.9rem;
  border-radius: var(--fma-radius-box);
  background: var(--color-primary);
  color: var(--color-primary-content);
}

.search {
  position: relative;
  flex: 1;
  max-width: 40rem;
  margin: 0 auto;
}

.search-icon {
  position: absolute;
  top: 50%;
  left: 0.65rem;
  color: var(--fma-muted);
  transform: translateY(-50%);
  pointer-events: none;
}

.search input {
  width: 100%;
  padding: 0.45rem var(--fma-space-3) 0.45rem 2.2rem;
  border: 1px solid var(--fma-border);
  border-radius: 999px;
  background: var(--color-base-200);
  font: inherit;
}

.search input:focus {
  border-color: var(--color-primary);
  outline: none;
  background: var(--color-base-100);
}

.actions {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  margin-left: auto;
}

.icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.4rem;
  border: none;
  border-radius: var(--fma-radius-box);
  background: transparent;
  color: var(--fma-muted);
}

.icon-button:hover {
  background: var(--color-base-200);
  color: var(--color-base-content);
}

.icon-button:disabled {
  opacity: 0.5;
}

.search-button,
.menu-button {
  display: none;
}

.search-layer {
  position: fixed;
  inset: 0;
  z-index: 60;
  padding: var(--fma-space-3);
  background: var(--color-base-100);
}

.search-layer-form {
  display: flex;
  gap: var(--fma-space-2);
}

.search-layer input {
  flex: 1;
  padding: 0.6rem 0.8rem;
  border: 1px solid var(--fma-border-strong);
  border-radius: var(--fma-radius-box);
  /* 16px avoids the automatic zoom on focus in iOS Safari. */
  font-size: 16px;
}

.hint {
  margin: var(--fma-space-3) var(--fma-space-1);
  color: var(--fma-muted);
  font-size: var(--fma-text-sm);
}

.help-panel {
  position: absolute;
  top: calc(100% + 0.25rem);
  right: 0.75rem;
  z-index: 50;
  width: min(22rem, calc(100vw - 1.5rem));
  padding: var(--fma-space-3) var(--fma-space-4);
  border: 1px solid var(--fma-border);
  border-radius: var(--fma-radius-box);
  background: var(--color-base-100);
  box-shadow: var(--fma-shadow);
}

.help-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--fma-space-2);
}

.help-head h2 {
  margin: 0;
  font-size: 1rem;
}

.help-panel {
  max-height: min(36rem, calc(100vh - 5rem));
  overflow-y: auto;
}

.help-panel h3 {
  margin: var(--fma-space-3) 0 0.35rem;
  color: var(--fma-muted);
  font-size: var(--fma-text-xs);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.help-panel dl {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.35rem var(--fma-space-3);
  margin: 0;
  font-size: var(--fma-text-sm);
}

.help-panel dd {
  margin: 0;
}

kbd {
  padding: 0.05rem 0.35rem;
  border: 1px solid var(--fma-border-strong);
  border-radius: 0.25rem;
  background: var(--color-base-200);
  font-family: ui-monospace, monospace;
  font-size: 0.8rem;
  white-space: nowrap;
}

@media (max-width: 760px) {
  .search {
    display: none;
  }

  .search-button,
  .menu-button {
    display: inline-flex;
  }

  .brand-name {
    display: none;
  }
}
</style>
