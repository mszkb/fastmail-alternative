<script setup lang="ts">
// Profile avatar with menu (#120): initials of the single user (ADR-0004);
// the menu holds "Einstellungen" and "Abmelden" - the one place to reach
// the settings. Keyboard: Enter/Space/Arrow down open it on the first
// item, Arrow up/down/Home/End move, Escape closes and returns the focus to
// the avatar, Tab closes. A click outside closes it as well.
import { accountInitials } from '@fma/shared'
import { IconLogout, IconSettings } from '@tabler/icons-vue'

const props = defineProps<{ email: string }>()
const emit = defineEmits<{ settings: []; logout: [] }>()

const open = ref(false)
const root = ref<HTMLElement | null>(null)
const button = ref<HTMLButtonElement | null>(null)
const panel = ref<HTMLElement | null>(null)

function menuItems(): HTMLButtonElement[] {
  return [...(panel.value?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]
}
const initials = computed(() => accountInitials('', props.email))

async function show(focus: 'first' | 'last' = 'first'): Promise<void> {
  open.value = true
  await nextTick()
  const list = menuItems()
  ;(focus === 'first' ? list[0] : list[list.length - 1])?.focus()
}

function close(returnFocus = false): void {
  open.value = false
  if (returnFocus) button.value?.focus()
}

function onButtonKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    void show(event.key === 'ArrowDown' ? 'first' : 'last')
  }
}

function onButtonClick(): void {
  if (open.value) close()
  else void show()
}

function onMenuKeydown(event: KeyboardEvent): void {
  const list = menuItems()
  const index = list.indexOf(document.activeElement as HTMLButtonElement)
  switch (event.key) {
    case 'Escape':
      event.preventDefault()
      close(true)
      return
    case 'Tab':
      close()
      return
    case 'ArrowDown':
      list[(index + 1) % list.length]?.focus()
      break
    case 'ArrowUp':
      list[(index - 1 + list.length) % list.length]?.focus()
      break
    case 'Home':
      list[0]?.focus()
      break
    case 'End':
      list[list.length - 1]?.focus()
      break
    default:
      return
  }
  event.preventDefault()
}

function choose(action: 'settings' | 'logout'): void {
  close(action === 'settings')
  if (action === 'settings') emit('settings')
  else emit('logout')
}

function onDocumentPointer(event: PointerEvent): void {
  if (open.value && root.value && !root.value.contains(event.target as Node)) close()
}

onMounted(() => document.addEventListener('pointerdown', onDocumentPointer))
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocumentPointer))
</script>

<template>
  <div ref="root" class="profile">
    <button
      ref="button"
      type="button"
      class="avatar-button"
      :aria-label="`Profil: ${email}`"
      :title="email"
      aria-haspopup="menu"
      :aria-expanded="open ? 'true' : 'false'"
      aria-controls="profile-menu"
      @click="onButtonClick"
      @keydown="onButtonKeydown"
    >
      <span aria-hidden="true">{{ initials }}</span>
    </button>
    <div
      v-if="open"
      id="profile-menu"
      ref="panel"
      class="menu-panel"
      role="menu"
      aria-label="Profil"
      @keydown="onMenuKeydown"
    >
      <p class="who" role="presentation">{{ email }}</p>
      <button type="button" role="menuitem" tabindex="-1" @click="choose('settings')">
        <IconSettings :size="18" aria-hidden="true" /> Einstellungen
      </button>
      <button type="button" role="menuitem" tabindex="-1" @click="choose('logout')">
        <IconLogout :size="18" aria-hidden="true" /> Abmelden
      </button>
    </div>
  </div>
</template>

<style scoped>
.profile {
  position: relative;
}

.avatar-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.25rem;
  height: 2.25rem;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: var(--color-neutral);
  color: var(--color-neutral-content);
  font-size: 0.85rem;
  font-weight: 700;
}

.avatar-button:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}

.menu-panel {
  position: absolute;
  top: calc(100% + 0.4rem);
  right: 0;
  z-index: 50;
  min-width: 14rem;
  padding: 0.35rem;
  border: 1px solid var(--fma-border);
  border-radius: 0.5rem;
  background: var(--color-base-100);
  box-shadow: var(--fma-shadow);
}

.who {
  margin: 0;
  padding: 0.4rem 0.6rem 0.5rem;
  overflow: hidden;
  border-bottom: 1px solid var(--fma-border);
  color: var(--fma-muted);
  font-size: 0.8rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.menu-panel button {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  margin-top: 0.25rem;
  padding: 0.45rem 0.6rem;
  border: none;
  border-radius: 0.375rem;
  background: transparent;
  color: var(--color-base-content);
  font: inherit;
  text-align: left;
}

.menu-panel button:hover,
.menu-panel button:focus-visible {
  background: var(--color-base-200);
  outline: none;
}
</style>
