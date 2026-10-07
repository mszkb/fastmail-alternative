<script setup lang="ts">
// Account bar (#120): the primary navigation between the mail accounts
// (principle 8) - where other mail apps switch between apps, we switch
// between accounts. One round icon per account with its initials and a
// stable color (accountInitials/accountColor from @fma/shared), the INBOX
// unread count as badge, a red dot on sync or login errors and the sync
// progress as a ring around the icon (#119). The active account carries
// aria-current. Order by drag and drop, or Alt+Arrow up/down on a focused
// icon; the new order is saved as the accounts' sort order.
// "Alle Konten" (unified inbox) only appears when switched on in the
// settings (off by default). "+" adds an account; the toggle at the bottom
// shows the names next to the icons.
// mode 'rail': narrow column on wide screens (names only when expanded);
// mode 'list': the same entries with names in the mobile side menu.
import {
  accountColor,
  accountInitials,
  isSyncBusy,
  isSyncError,
  moveId,
  reorderIds,
  syncFraction,
  syncStateText,
} from '@fma/shared'
import type { AccountStatus, AccountSyncStatus } from '@fma/shared'
import {
  IconInbox,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconPlus,
} from '@tabler/icons-vue'

interface RailAccount {
  id: string
  displayName: string
  emailAddress: string
  unreadCount?: number
  status?: AccountStatus
}

const props = defineProps<{
  accounts: RailAccount[]
  activeAccountId: string
  statuses: AccountSyncStatus[]
  unifiedInbox: boolean
  unifiedActive: boolean
  mode: 'rail' | 'list'
  expanded?: boolean
}>()
const emit = defineEmits<{
  select: [accountId: string]
  openUnified: []
  add: []
  reorder: [accountIds: string[]]
  'update:expanded': [expanded: boolean]
}>()

const dragging = ref('')
const dropTarget = ref('')
const showNames = computed(() => props.mode === 'list' || props.expanded)

const entries = computed(() =>
  props.accounts.map((account, index) => {
    const status = props.statuses.find((s) => s.accountId === account.id)
    const busy = isSyncBusy(status)
    const failed =
      isSyncError(status) || account.status === 'auth_error' || account.status === 'unreachable'
    const unread = account.unreadCount ?? 0
    const parts = [
      account.displayName,
      account.emailAddress,
      unread > 0 ? `${unread} ungelesen` : '',
      failed ? (status ? syncStateText(status) : 'Fehler') : '',
      busy ? 'wird synchronisiert' : '',
      index < 9 ? `Strg+${index + 1}` : '',
    ]
    return {
      account,
      initials: accountInitials(account.displayName, account.emailAddress),
      color: accountColor(account.id),
      unread,
      busy,
      failed,
      fraction: busy && status ? syncFraction(status) : null,
      label: parts.filter(Boolean).join(', '),
      tip: `${account.displayName} – ${account.emailAddress}${index < 9 ? ` (Strg+${index + 1})` : ''}`,
      active: !props.unifiedActive && account.id === props.activeAccountId,
    }
  }),
)

function unreadText(count: number): string {
  return count > 999 ? '999+' : String(count)
}

function onDragStart(event: DragEvent, id: string): void {
  dragging.value = id
  event.dataTransfer?.setData('text/plain', id)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function onDragOver(event: DragEvent, id: string): void {
  if (!dragging.value) return
  event.preventDefault()
  dropTarget.value = id
}

function onDrop(event: DragEvent, id: string): void {
  event.preventDefault()
  const moved = dragging.value
  dragging.value = ''
  dropTarget.value = ''
  if (!moved || moved === id) return
  emit(
    'reorder',
    reorderIds(
      props.accounts.map((a) => a.id),
      moved,
      id,
    ),
  )
}

function onDragEnd(): void {
  dragging.value = ''
  dropTarget.value = ''
}

/** Alt+Arrow up/down moves the focused account (keyboard reordering). */
function onKeydown(event: KeyboardEvent, id: string): void {
  if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
  event.preventDefault()
  const ids = props.accounts.map((a) => a.id)
  const next = moveId(ids, id, event.key === 'ArrowUp' ? -1 : 1)
  if (next.join() !== ids.join()) emit('reorder', next)
}
</script>

<template>
  <nav class="account-rail" :class="[`mode-${mode}`, { expanded: showNames }]" aria-label="Konten">
    <ul class="entries">
      <li v-if="unifiedInbox">
        <button
          type="button"
          class="entry"
          :class="{ active: unifiedActive }"
          :aria-current="unifiedActive ? 'true' : undefined"
          aria-label="Alle Konten (gemeinsamer Posteingang)"
          :title="showNames ? undefined : 'Alle Konten'"
          @click="emit('openUnified')"
        >
          <span class="avatar unified" aria-hidden="true">
            <IconInbox :size="20" stroke-width="1.75" />
          </span>
          <span v-if="showNames" class="name" aria-hidden="true">Alle Konten</span>
        </button>
      </li>
      <li
        v-for="entry in entries"
        :key="entry.account.id"
        :class="{ 'drop-target': dropTarget === entry.account.id && dragging !== entry.account.id }"
        @dragover="onDragOver($event, entry.account.id)"
        @drop="onDrop($event, entry.account.id)"
      >
        <button
          type="button"
          class="entry"
          :class="{ active: entry.active }"
          :aria-current="entry.active ? 'true' : undefined"
          :aria-label="entry.label"
          :title="showNames ? undefined : entry.tip"
          draggable="true"
          @click="emit('select', entry.account.id)"
          @keydown="onKeydown($event, entry.account.id)"
          @dragstart="onDragStart($event, entry.account.id)"
          @dragend="onDragEnd"
        >
          <span class="avatar" :style="{ background: entry.color }" aria-hidden="true">
            {{ entry.initials }}
            <svg v-if="entry.busy" class="ring" viewBox="0 0 44 44" focusable="false">
              <circle
                cx="22"
                cy="22"
                r="20"
                pathLength="100"
                :class="{ spinning: entry.fraction === null }"
                :stroke-dasharray="`${entry.fraction === null ? 25 : Math.max(3, entry.fraction * 100)} 100`"
              />
            </svg>
            <span v-if="entry.failed" class="error-dot" />
            <span v-if="entry.unread > 0" class="badge-count">{{ unreadText(entry.unread) }}</span>
          </span>
          <span v-if="showNames" class="name" aria-hidden="true">
            <span class="display-name">{{ entry.account.displayName }}</span>
            <span class="address">{{ entry.account.emailAddress }}</span>
          </span>
        </button>
      </li>
      <li>
        <button
          type="button"
          class="entry add"
          aria-label="Konto hinzufügen"
          :title="showNames ? undefined : 'Konto hinzufügen'"
          @click="emit('add')"
        >
          <span class="avatar outline" aria-hidden="true"><IconPlus :size="20" /></span>
          <span v-if="showNames" class="name" aria-hidden="true">Konto hinzufügen</span>
        </button>
      </li>
    </ul>
    <button
      v-if="mode === 'rail'"
      type="button"
      class="collapse-toggle"
      :aria-label="expanded ? 'Kontoleiste einklappen' : 'Kontoleiste ausklappen'"
      :aria-expanded="expanded ? 'true' : 'false'"
      :title="expanded ? 'Kontoleiste einklappen' : 'Kontoleiste ausklappen'"
      @click="emit('update:expanded', !expanded)"
    >
      <IconLayoutSidebarLeftCollapse v-if="expanded" :size="20" aria-hidden="true" />
      <IconLayoutSidebarLeftExpand v-else :size="20" aria-hidden="true" />
    </button>
  </nav>
</template>

<style scoped>
.account-rail {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: var(--fma-space-2);
  min-height: 0;
  padding: var(--fma-space-2) 0.4rem;
  overflow-y: auto;
  background: var(--color-base-200);
}

.account-rail.mode-rail {
  width: 4.25rem;
  border-right: 1px solid var(--fma-border);
}

.account-rail.mode-rail.expanded {
  width: 15rem;
}

.account-rail.mode-list {
  background: transparent;
  padding: 0;
}

.entries {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.entries li.drop-target {
  box-shadow: inset 0 3px 0 var(--color-primary);
  border-radius: 0.25rem;
}

.entry {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.6rem;
  width: 100%;
  padding: var(--fma-space-1);
  border: none;
  border-radius: 0.75rem;
  background: transparent;
  color: var(--color-base-content);
  text-align: left;
}

.entry:hover {
  background: var(--color-base-300);
}

.entry:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 1px;
}

/* Active account: a bar at the left edge and a ring around the icon. */
.entry.active {
  background: var(--fma-primary-soft);
}

.entry.active::before {
  content: '';
  position: absolute;
  top: 0.45rem;
  bottom: 0.45rem;
  left: -0.4rem;
  width: 0.25rem;
  border-radius: 0 0.25rem 0.25rem 0;
  background: var(--color-primary);
}

.entry.active .avatar {
  box-shadow:
    0 0 0 2px var(--color-base-100),
    0 0 0 4px var(--color-primary);
}

.avatar {
  position: relative;
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 2.5rem;
  height: 2.5rem;
  border-radius: 50%;
  /* Initials on the account color: white is AA on every palette color. */
  color: #fff;
  font-size: 0.9rem;
  font-weight: 700;
  letter-spacing: 0.02em;
  user-select: none;
}

.avatar.unified {
  background: var(--color-neutral);
  color: var(--color-neutral-content);
}

.avatar.outline {
  border: 2px dashed var(--fma-border-strong);
  color: var(--fma-muted);
}

.ring {
  position: absolute;
  inset: -0.25rem;
  width: calc(100% + 0.5rem);
  height: calc(100% + 0.5rem);
  pointer-events: none;
}

.ring circle {
  fill: none;
  stroke: var(--color-primary);
  stroke-width: 3;
  stroke-linecap: round;
  transform: rotate(-90deg);
  transform-origin: center;
}

.ring circle.spinning {
  animation: rail-spin 1s linear infinite;
}

@keyframes rail-spin {
  to {
    transform: rotate(270deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .ring circle.spinning {
    animation: none;
  }
}

.error-dot {
  position: absolute;
  bottom: -0.05rem;
  right: -0.05rem;
  width: 0.75rem;
  height: 0.75rem;
  border: 2px solid var(--color-base-200);
  border-radius: 50%;
  background: var(--color-error);
}

.badge-count {
  position: absolute;
  top: -0.35rem;
  right: -0.5rem;
  min-width: 1.15rem;
  padding: 0 0.3rem;
  border: 2px solid var(--color-base-200);
  border-radius: 999px;
  background: var(--color-primary);
  color: var(--color-primary-content);
  font-size: 0.65rem;
  line-height: 1rem;
  text-align: center;
}

.name {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.name,
.display-name {
  overflow: hidden;
  font-size: 0.9rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.address {
  overflow: hidden;
  color: var(--fma-muted);
  font-size: var(--fma-text-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.collapse-toggle {
  align-self: center;
  display: inline-flex;
  padding: 0.4rem;
  border: none;
  border-radius: var(--fma-radius-box);
  background: transparent;
  color: var(--fma-muted);
}

.collapse-toggle:hover {
  background: var(--color-base-300);
}
</style>
