<script setup lang="ts">
// Sync indicator and panel (#119). The indicator sits next to the refresh
// button of the list (until the account bar of #120 exists): a ring that
// spins while a sync runs (or fills with the progress of the active
// account) and a red dot when an account has an error. A click opens the
// panel: per account the folder, phase, "done / total" with a progress
// bar, the duration, and "Stoppen" (per account and "Alle stoppen"), then
// "Jetzt synchronisieren". Errors explain themselves and link to the
// account settings.
// The status comes from app.vue (GET /api/sync/status, polled only while a
// sync is active). Folder names are resolved here from the folder lists
// (the status only carries ids): the active account's folders are passed
// in, other accounts' lists are loaded when needed. Backends without the
// status endpoint (Node) give `canCancel` false: no stop buttons, the
// state then only says whether a sync runs.
import {
  finishedSyncs,
  formatSyncDuration,
  isSyncActive,
  isSyncBusy,
  isSyncError,
  syncFraction,
  syncPhaseLabel,
  syncProgressText,
  syncStateText,
} from '@fma/shared'
import type { AccountSyncStatus, FolderListResponse, FolderSummary } from '@fma/shared'

const props = defineProps<{
  accounts: { id: string; displayName: string }[]
  statuses: AccountSyncStatus[]
  /** The backend supports stopping (GET /api/sync/status exists). */
  canCancel: boolean
  activeAccountId: string
  /** Folders of the active account, already loaded by the mail view. */
  activeFolders: FolderSummary[]
  folderLabel: (folder: FolderSummary) => string
  /** Offline: the panel opens, its actions are disabled. */
  disabled?: boolean
}>()
const emit = defineEmits<{
  cancel: [accountId: string | null]
  sync: [accountId: string]
  editAccount: [accountId: string]
}>()

const open = ref(false)
const root = ref<HTMLElement | null>(null)
const toggleButton = ref<HTMLButtonElement | null>(null)
const announcement = ref('')
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | undefined
// Folder lists of other accounts, loaded on demand: folder id -> label.
const otherFolders = reactive(new Map<string, string>())
const requestedFolders = new Set<string>()

const rows = computed(() =>
  props.accounts.map((account) => ({
    account,
    status: props.statuses.find((s) => s.accountId === account.id) ?? null,
  })),
)
const anyActive = computed(() => props.statuses.some(isSyncActive))
const anyBusy = computed(() => props.statuses.some(isSyncBusy))
const anyError = computed(() => props.statuses.some(isSyncError))
const activeStatus = computed(
  () => props.statuses.find((s) => s.accountId === props.activeAccountId) ?? null,
)
/** Ring fill: progress of the active account's running sync, else spinning. */
const ringFraction = computed(() =>
  activeStatus.value && isSyncBusy(activeStatus.value) ? syncFraction(activeStatus.value) : null,
)
const indicatorLabel = computed(() => {
  const state = anyBusy.value
    ? 'Synchronisierung läuft'
    : anyActive.value
      ? 'Synchronisierung wird gestoppt'
      : anyError.value
        ? 'Fehler bei der Synchronisierung'
        : 'Alles synchronisiert'
  return `Synchronisierungsstatus: ${state}`
})

function folderName(status: AccountSyncStatus): string | null {
  if (!status.folderId) return null
  if (status.accountId === props.activeAccountId) {
    const folder = props.activeFolders.find((f) => f.id === status.folderId)
    if (folder) return props.folderLabel(folder)
  }
  return otherFolders.get(status.folderId) ?? null
}

async function loadFolders(accountId: string, folderId: string): Promise<void> {
  const key = `${accountId}/${folderId}`
  if (requestedFolders.has(key)) return
  requestedFolders.add(key)
  try {
    const res = await fetch(`/api/accounts/${accountId}/folders`)
    if (!res.ok) return
    const body = (await res.json()) as FolderListResponse
    for (const folder of body.folders) otherFolders.set(folder.id, props.folderLabel(folder))
  } catch {
    // Offline: the generic "Ordner" stays.
  }
}

function progressText(status: AccountSyncStatus): string | null {
  return isSyncActive(status) ? syncProgressText(status, folderName(status)) : null
}

function duration(status: AccountSyncStatus): string | null {
  if (!status.startedAt || !isSyncActive(status)) return null
  return formatSyncDuration(now.value - Date.parse(status.startedAt))
}

function percent(status: AccountSyncStatus): number | null {
  const fraction = syncFraction(status)
  return fraction === null ? null : Math.round(fraction * 100)
}

function lastSync(status: AccountSyncStatus): string | null {
  if (!status.lastSyncAt) return null
  return new Date(status.lastSyncAt).toLocaleString('de-DE', {
    dateStyle: 'short',
    timeStyle: 'short',
  })
}

function canSync(status: AccountSyncStatus | null): boolean {
  return !status || (!isSyncActive(status) && status.state !== 'paused')
}

function close(focus = false): void {
  open.value = false
  if (focus) toggleButton.value?.focus()
}

function onDocumentPointer(event: PointerEvent): void {
  if (open.value && root.value && !root.value.contains(event.target as Node)) close()
}

// Unknown folder ids of other accounts: load their folder list once.
watch(
  () => [open.value, props.statuses] as const,
  ([isOpen, statuses]) => {
    if (!isOpen) return
    for (const status of statuses) {
      if (status.folderId && status.accountId !== props.activeAccountId && !folderName(status)) {
        void loadFolders(status.accountId, status.folderId)
      }
    }
  },
)

// Elapsed time ticks only while the panel is open and a sync is active.
watch(
  () => open.value && anyActive.value,
  (ticking) => {
    clearInterval(clock)
    if (ticking) {
      now.value = Date.now()
      clock = setInterval(() => (now.value = Date.now()), 1000)
    }
  },
)

// Status changes for screen readers (aria-live="polite").
watch(
  () => props.statuses,
  (next, previous) => {
    if (!previous) return
    const name = (id: string) => props.accounts.find((a) => a.id === id)?.displayName ?? 'Konto'
    const messages: string[] = []
    for (const id of finishedSyncs(previous, next)) {
      const status = next.find((s) => s.accountId === id)
      const was = previous.find((s) => s.accountId === id)
      if (!status) continue
      if (isSyncError(status)) messages.push(`${name(id)}: ${syncStateText(status)}`)
      else if (was?.state === 'cancelling') messages.push(`${name(id)}: Synchronisierung gestoppt`)
      else messages.push(`${name(id)}: Synchronisierung abgeschlossen`)
    }
    for (const status of next) {
      const was = previous.find((s) => s.accountId === status.accountId)
      if (isSyncBusy(status) && !isSyncActive(was)) {
        messages.push(`${name(status.accountId)}: Synchronisierung läuft`)
      } else if (status.state === 'cancelling' && was?.state !== 'cancelling') {
        messages.push(`${name(status.accountId)}: Synchronisierung wird gestoppt`)
      }
    }
    if (messages.length > 0) announcement.value = messages.join('. ')
  },
)

onMounted(() => document.addEventListener('pointerdown', onDocumentPointer))
onBeforeUnmount(() => {
  clearInterval(clock)
  document.removeEventListener('pointerdown', onDocumentPointer)
})
</script>

<template>
  <div ref="root" class="sync-status" @keydown.esc.prevent="close(true)">
    <button
      ref="toggleButton"
      type="button"
      class="sync-indicator"
      :class="{ busy: anyBusy, error: anyError }"
      :aria-label="indicatorLabel"
      :title="indicatorLabel"
      :aria-expanded="open"
      aria-controls="sync-panel"
      @click="open = !open"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle class="track" cx="12" cy="12" r="9" />
        <circle
          v-if="anyBusy"
          class="ring"
          :class="{ spinning: ringFraction === null }"
          cx="12"
          cy="12"
          r="9"
          pathLength="100"
          :stroke-dasharray="`${ringFraction === null ? 25 : Math.max(2, ringFraction * 100)} 100`"
        />
        <circle v-else-if="!anyError" class="ok" cx="12" cy="12" r="3" />
      </svg>
      <span v-if="anyError" class="error-dot" aria-hidden="true" />
    </button>
    <p class="visually-hidden" aria-live="polite">{{ announcement }}</p>

    <div v-if="open" id="sync-panel" class="sync-panel" role="dialog" aria-label="Synchronisierung">
      <header>
        <h3>Synchronisierung</h3>
        <button
          v-if="canCancel && anyActive"
          type="button"
          class="secondary"
          :disabled="disabled"
          @click="emit('cancel', null)"
        >
          Alle stoppen
        </button>
        <button type="button" class="close" aria-label="Schließen" @click="close(true)">
          &times;
        </button>
      </header>
      <ul>
        <li v-for="{ account, status } in rows" :key="account.id" :aria-label="account.displayName">
          <div class="line">
            <strong>{{ account.displayName }}</strong>
            <span class="state" :class="status?.state">{{
              status ? syncStateText(status) : 'Unbekannt'
            }}</span>
          </div>
          <template v-if="status && isSyncActive(status)">
            <p v-if="progressText(status)" class="progress-text">{{ progressText(status) }}</p>
            <p class="meta">
              <span v-if="syncPhaseLabel(status.phase)">{{ syncPhaseLabel(status.phase) }}</span>
              <span v-if="duration(status)">seit {{ duration(status) }}</span>
              <span v-if="status.queuedJobs > 0">{{ status.queuedJobs }} Ordner ausstehend</span>
            </p>
            <div
              class="bar"
              :class="{ indeterminate: percent(status) === null }"
              role="progressbar"
              :aria-label="`Fortschritt ${account.displayName}`"
              aria-valuemin="0"
              aria-valuemax="100"
              :aria-valuenow="percent(status) ?? undefined"
              :aria-valuetext="progressText(status) ?? syncStateText(status)"
            >
              <span :style="{ width: `${percent(status) ?? 30}%` }" />
            </div>
          </template>
          <p v-else-if="status && lastSync(status)" class="meta">
            Zuletzt synchronisiert: {{ lastSync(status) }}
          </p>
          <div class="actions">
            <button
              v-if="canCancel && status && isSyncActive(status)"
              type="button"
              class="secondary"
              :disabled="disabled || status.state === 'cancelling'"
              @click="emit('cancel', account.id)"
            >
              Stoppen
            </button>
            <button
              v-else-if="canSync(status)"
              type="button"
              :disabled="disabled"
              @click="emit('sync', account.id)"
            >
              Jetzt synchronisieren
            </button>
            <button
              v-if="status && isSyncError(status)"
              type="button"
              class="link"
              @click="emit('editAccount', account.id)"
            >
              Kontoeinstellungen öffnen
            </button>
          </div>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.sync-status {
  position: relative;
  display: inline-flex;
}

.sync-indicator {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--color-primary);
  cursor: pointer;
}

.sync-indicator svg {
  width: 1.4rem;
  height: 1.4rem;
}

.track {
  fill: none;
  stroke: var(--fma-border);
  stroke-width: 3;
}

.ring {
  fill: none;
  stroke: currentColor;
  stroke-width: 3;
  stroke-linecap: round;
  transform: rotate(-90deg);
  transform-origin: center;
}

.ring.spinning {
  animation: sync-spin 1s linear infinite;
}

.ok {
  fill: var(--color-success);
}

@keyframes sync-spin {
  to {
    transform: rotate(270deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .ring.spinning {
    animation: none;
  }
}

.error-dot {
  position: absolute;
  top: 0.2rem;
  right: 0.2rem;
  width: 0.55rem;
  height: 0.55rem;
  border: 2px solid var(--color-base-100);
  border-radius: 50%;
  background: var(--color-error);
}

.sync-panel {
  position: absolute;
  top: calc(100% + 0.25rem);
  right: 0;
  z-index: 30;
  width: min(22rem, calc(100vw - 2rem));
  max-height: 70vh;
  overflow-y: auto;
  padding: 0.75rem;
  border: 1px solid var(--fma-border);
  border-radius: 0.5rem;
  background: var(--color-base-100);
  box-shadow: 0 6px 24px rgb(0 0 0 / 18%);
  text-align: left;
}

.sync-panel header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

.sync-panel h3 {
  flex: 1;
  margin: 0;
  font-size: 1rem;
}

.sync-panel ul {
  list-style: none;
  margin: 0;
  padding: 0;
}

.sync-panel li {
  padding: 0.6rem 0;
  border-top: 1px solid var(--color-base-300);
}

.line {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.25rem 0.5rem;
}

.state {
  font-size: 0.8rem;
  color: var(--fma-muted);
}

.state.error,
.state.auth_error {
  color: var(--color-error);
}

.progress-text,
.meta {
  margin: 0.25rem 0 0;
  font-size: 0.85rem;
  color: var(--fma-muted);
}

.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0 0.75rem;
  color: var(--fma-muted);
}

.bar {
  height: 0.35rem;
  margin-top: 0.4rem;
  overflow: hidden;
  border-radius: 999px;
  background: var(--color-base-300);
}

.bar span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--color-primary);
  transition: width 0.3s;
}

.bar.indeterminate span {
  animation: sync-bar 1.2s ease-in-out infinite;
}

@keyframes sync-bar {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(340%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .bar.indeterminate span {
    animation: none;
  }
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin-top: 0.5rem;
}

.actions:empty {
  display: none;
}

.sync-panel button {
  padding: 0.35rem 0.75rem;
  border: none;
  border-radius: 0.375rem;
  background: var(--color-primary);
  color: var(--color-primary-content);
  font: inherit;
  font-size: 0.85rem;
  cursor: pointer;
}

.sync-panel button.secondary {
  background: var(--color-base-300);
  color: var(--color-base-content);
}

.sync-panel button.link {
  background: transparent;
  color: var(--color-success);
  font-weight: 600;
}

.sync-panel button.close {
  padding: 0.1rem 0.5rem;
  background: transparent;
  color: var(--fma-muted);
  font-size: 1.2rem;
}

.sync-panel button:disabled {
  opacity: 0.6;
  cursor: default;
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
</style>
