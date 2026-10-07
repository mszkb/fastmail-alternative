<script setup lang="ts">
// Message body (roadmap 2.9): sanitized HTML from /api/messages/:id/html,
// falling back to the plain text when there is no HTML part.
//
// Security layers for HTML (the server-side sanitizer is the first):
// - Rendered only via srcdoc in an iframe sandboxed WITHOUT allow-scripts and
//   WITHOUT allow-same-origin: no script runs and the mail gets an opaque
//   origin (no access to the app, its cookies or storage). allow-popups(+
//   escape-sandbox) only lets links open in a new, normal tab.
// - A CSP inside the srcdoc: nothing may load except inline styles and
//   data: images - plus http(s) images once the user loaded external
//   content for this message. No referrer is sent.
// - Height: without scripts or same-origin access the parent cannot measure
//   the document, and rendering mail HTML into the app's own DOM to measure
//   it would forfeit the isolation. The frame therefore has a fixed height
//   (scrolls inside) and can be resized by the user.
// Offline (4.6): the sanitized HTML without remote content is cached
// (encrypted, utils/offline-store.ts) and shown first, then refreshed;
// HTML with remote images is never cached (it would load them offline).
import type { MessageDetail, MessageHtmlResponse } from '@fma/shared'
import { cacheGet, cachePut } from '~/utils/offline-store'

const props = defineProps<{ message: MessageDetail }>()

const html = ref<string | null>(null)
const remoteBlocked = ref(false)
const remoteAllowed = ref(false)
const loading = ref(true)
const showText = ref(false)

const BASE_STYLE =
  'html{color-scheme:light}body{margin:0;padding:12px;font-family:system-ui,-apple-system,' +
  'Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.45;color:#1f2933;background:#fff;' +
  'overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}' +
  'pre{white-space:pre-wrap}'

function csp(remote: boolean): string {
  return [
    "default-src 'none'",
    `img-src data:${remote ? ' https: http:' : ''}`,
    "style-src 'unsafe-inline'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ')
}

const srcdoc = computed(() =>
  html.value === null
    ? ''
    : '<!DOCTYPE html><html><head><meta charset="utf-8">' +
      `<meta http-equiv="Content-Security-Policy" content="${csp(remoteAllowed.value)}">` +
      '<meta name="referrer" content="no-referrer">' +
      `<style>${BASE_STYLE}</style></head><body>${html.value}</body></html>`,
)

let request = 0

function show(body: MessageHtmlResponse, remote: boolean): void {
  html.value = body.html
  remoteBlocked.value = body.remoteContentBlocked
  remoteAllowed.value = remote
}

async function load(remote: boolean): Promise<void> {
  const current = ++request
  const { id, accountId } = props.message
  const cacheKey = `html:${id}`
  loading.value = true
  let cached: MessageHtmlResponse | null = null
  try {
    const network = fetch(`/api/messages/${id}/html?remote=${remote ? 1 : 0}`)
    network.catch(() => {}) // handled below
    if (!remote) {
      cached = await cacheGet<MessageHtmlResponse>(cacheKey)
      if (cached && current === request) {
        show(cached, false)
        loading.value = false
      }
    }
    const res = await network
    if (!res.ok) throw new Error(`Fehler ${res.status}`)
    const body = (await res.json()) as MessageHtmlResponse
    if (current !== request) return
    show(body, remote)
    if (!remote) void cachePut(cacheKey, body, { accountId })
  } catch {
    // HTML is optional: fall back to the plain text (or keep the cached HTML).
    if (current === request && !cached) html.value = null
  } finally {
    if (current === request) loading.value = false
  }
}

function loadRemote(): void {
  void load(true)
}

watch(
  () => props.message.id,
  () => {
    html.value = null
    remoteBlocked.value = false
    showText.value = false
    void load(false)
  },
  { immediate: true },
)
</script>

<template>
  <div class="message-body">
    <template v-if="html !== null && !showText">
      <div class="body-bar">
        <p v-if="remoteBlocked" class="remote-banner" role="status">
          Externe Inhalte wurden blockiert.
          <button type="button" class="link" @click="loadRemote">Laden</button>
        </p>
        <button type="button" class="link toggle" @click="showText = true">
          Als Text anzeigen
        </button>
      </div>
      <div class="frame-wrap">
        <iframe
          class="html-frame"
          title="Nachrichteninhalt"
          sandbox="allow-popups allow-popups-to-escape-sandbox"
          referrerpolicy="no-referrer"
          :srcdoc="srcdoc"
        />
      </div>
    </template>
    <template v-else-if="!loading">
      <div v-if="html !== null" class="body-bar">
        <button type="button" class="link toggle" @click="showText = false">
          Als HTML anzeigen
        </button>
      </div>
      <!-- Plain text: rendered via text interpolation, never v-html. -->
      <pre v-if="message.text !== null" class="body">{{ message.text }}</pre>
      <p v-else class="hint">Inhalt wird noch synchronisiert &hellip;</p>
    </template>
    <MessageAttachments v-if="message.hasAttachments" :message-id="message.id" />
  </div>
</template>

<style scoped>
.body-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 1rem;
  margin-bottom: 0.5rem;
  font-size: 0.85rem;
}

.remote-banner {
  flex: 1;
  margin: 0;
  padding: 0.4rem 0.6rem;
  border: 1px solid var(--fma-warning-border);
  border-radius: 4px;
  background: var(--fma-warning-soft);
  color: var(--fma-warning-text);
}

.toggle {
  margin-left: auto;
}

.link {
  padding: 0;
  border: none;
  background: none;
  color: var(--color-primary);
  font: inherit;
  text-decoration: underline;
  cursor: pointer;
}

/* Fixed, user-resizable height (see the comment in the script block). */
.frame-wrap {
  height: 65vh;
  min-height: 12rem;
  overflow: hidden;
  resize: vertical;
  border: 1px solid var(--color-base-300);
  border-radius: 4px;
}

.html-frame {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  background: var(--color-base-100);
}

.body {
  margin: 0;
  font-family: inherit;
  font-size: 0.95rem;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.hint {
  margin: 0.75rem 0;
  font-size: 0.85rem;
  color: var(--fma-muted);
}
</style>
