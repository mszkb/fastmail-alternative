<script setup lang="ts">
// Installable themes (#126) in Settings → Darstellung: upload a theme file
// (checked here with parseThemeFile, then by the server), list the
// installed themes (GET /api/themes, cached for offline use), preview,
// activate per device, delete; "Standard" is always there. Activating also
// takes over the theme's layout options once (emit `layout`), afterwards
// they can be changed as usual.
import { parseThemeFile } from '@fma/shared'
import type { InstalledTheme, Theme, ThemeLayout, ThemeListResponse } from '@fma/shared'
import { cacheGet, cachePut } from '~/utils/offline-store'
import { activateTheme, activeThemeId, previewTheme, previewThemeId } from '~/utils/user-theme'

const emit = defineEmits<{ layout: [layout: ThemeLayout] }>()

const CACHE_KEY = 'themes'
const themes = ref<InstalledTheme[]>([])
const busy = ref(false)
const errors = ref<string[]>([])
const notice = ref('')
/** Contrast warnings of the theme just installed. */
const warnings = ref<string[]>([])

async function load(): Promise<void> {
  const cached = await cacheGet<InstalledTheme[]>(CACHE_KEY)
  if (cached && themes.value.length === 0) themes.value = cached
  try {
    const res = await fetch('/api/themes')
    if (!res.ok) return
    themes.value = ((await res.json()) as ThemeListResponse).themes
    void cachePut(CACHE_KEY, themes.value, { pinned: true })
  } catch {
    // Offline: the cached list stays.
  }
}

async function install(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  errors.value = []
  notice.value = ''
  warnings.value = []
  const text = await file.text()
  const checked = parseThemeFile(text)
  if (!checked.ok) {
    errors.value = checked.errors
    return
  }
  busy.value = true
  try {
    const res = await fetch('/api/themes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: text,
    })
    const body = (await res.json().catch(() => null)) as
      (InstalledTheme & { message?: string; errors?: string[] }) | null
    if (!res.ok || !body) {
      errors.value = body?.errors?.length ? body.errors : [body?.message ?? `Fehler ${res.status}`]
      return
    }
    notice.value = `„${body.name}“ ist installiert.`
    warnings.value = body.warnings ?? []
    await load()
    // An update of the active theme applies at once.
    if (activeThemeId.value === body.id) activateTheme(body.theme)
  } catch {
    errors.value = ['Das Theme konnte nicht hochgeladen werden (keine Verbindung?).']
  } finally {
    busy.value = false
  }
}

function activate(theme: Theme | null): void {
  activateTheme(theme)
  if (theme?.layout) emit('layout', theme.layout)
  notice.value = theme ? `„${theme.name}“ ist aktiv.` : 'Standard-Design ist aktiv.'
}

function togglePreview(theme: Theme): void {
  previewTheme(previewThemeId.value === theme.id ? null : theme)
}

async function remove(item: InstalledTheme): Promise<void> {
  if (!confirm(`Theme „${item.name}“ löschen?`)) return
  busy.value = true
  try {
    const res = await fetch(`/api/themes/${encodeURIComponent(item.id)}`, { method: 'DELETE' })
    if (!res.ok && res.status !== 404) {
      errors.value = [`Löschen fehlgeschlagen (Fehler ${res.status}).`]
      return
    }
    if (activeThemeId.value === item.id) activateTheme(null)
    if (previewThemeId.value === item.id) previewTheme(null)
    await load()
  } catch {
    errors.value = ['Löschen ist nur online möglich.']
  } finally {
    busy.value = false
  }
}

onMounted(() => void load())
onBeforeUnmount(() => {
  if (previewThemeId.value) previewTheme(null)
})
</script>

<template>
  <fieldset class="choices themes">
    <legend>Theme</legend>
    <ul class="theme-list">
      <li>
        <span class="theme-name">Standard</span>
        <span v-if="!activeThemeId" class="tag">Aktiv</span>
        <button v-else type="button" class="link" @click="activate(null)">Aktivieren</button>
      </li>
      <li v-for="item in themes" :key="item.id" :data-theme-id="item.id">
        <span class="theme-name"
          >{{ item.name }} <span class="hint">{{ item.version }}</span
          ><span
            v-if="item.warnings?.length"
            class="contrast-warning"
            :title="item.warnings.join('\n')"
          >
            · geringer Kontrast</span
          ></span
        >
        <span v-if="activeThemeId === item.id" class="tag">Aktiv</span>
        <template v-else>
          <button
            type="button"
            class="link"
            :aria-pressed="previewThemeId === item.id"
            @click="togglePreview(item.theme)"
          >
            {{ previewThemeId === item.id ? 'Vorschau beenden' : 'Vorschau' }}
          </button>
          <button type="button" class="link" @click="activate(item.theme)">Aktivieren</button>
        </template>
        <button type="button" class="link danger" :disabled="busy" @click="remove(item)">
          Löschen
        </button>
      </li>
    </ul>
    <label class="install">
      <span class="secondary button-like">Theme installieren …</span>
      <input
        type="file"
        accept=".json,application/json"
        class="sr-only"
        aria-label="Theme-Datei installieren"
        :disabled="busy"
        @change="install"
      />
    </label>
    <p v-if="notice" class="message info" role="status">{{ notice }}</p>
    <div v-if="warnings.length" class="message warning" role="alert">
      <p>Installiert, aber schlecht lesbar – zu wenig Kontrast:</p>
      <ul>
        <li v-for="(warning, index) in warnings" :key="index">{{ warning }}</li>
      </ul>
    </div>
    <div v-if="errors.length" class="message error" role="alert">
      <p>Das Theme wurde nicht installiert:</p>
      <ul>
        <li v-for="(error, index) in errors" :key="index">{{ error }}</li>
      </ul>
    </div>
    <p class="hint">
      Themes ändern Farben, Abstände und Anordnung, enthalten aber keinen Code. Die Auswahl gilt für
      dieses Gerät. Falls ein Theme die Oberfläche unbrauchbar macht: Adresse mit
      <code>?theme=default</code> öffnen. Eigene Themes:
      <a
        href="https://github.com/mszkb/fastmail-alternative/blob/main/docs/themes/README.md"
        target="_blank"
        rel="noopener noreferrer"
        >Anleitung</a
      >.
    </p>
  </fieldset>
</template>

<style scoped>
.theme-list {
  list-style: none;
  margin: 0 0 var(--fma-space-2);
  padding: 0;
}

.theme-list li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--fma-space-2);
  padding: 0.3rem 0;
  border-bottom: 1px solid var(--fma-border);
}

.theme-name {
  flex: 1;
}

.tag {
  font-size: var(--fma-text-xs);
  padding: 0 0.4rem;
  border-radius: 999px;
  background: var(--fma-primary-soft);
}

.contrast-warning {
  color: var(--fma-warning-text);
  font-size: var(--fma-text-xs);
}

.danger {
  color: var(--color-error);
}

.install {
  display: inline-block;
  cursor: pointer;
}

.button-like {
  display: inline-block;
  padding: 0.35rem 0.8rem;
  border: 1px solid var(--fma-border-strong);
  border-radius: var(--fma-radius);
}

.install:focus-within .button-like {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
</style>
