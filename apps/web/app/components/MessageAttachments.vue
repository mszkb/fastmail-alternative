<script setup lang="ts">
// Attachments of a received message (roadmap 5.3), listed from
// /api/messages/:id/attachments. Downloads are plain links: the api sends
// them as `Content-Disposition: attachment` with nosniff and a sandbox CSP;
// only raster images and plain text may be opened inline ("Ansehen").
// Inline images referenced from the HTML (cid:) are shown in the body and
// not listed again. Nothing here is cached offline.
import {
  formatByteSize,
  isInlineSafeType,
  type MessageAttachment,
  type MessageAttachmentListResponse,
} from '@fma/shared'

const props = defineProps<{ messageId: string }>()

const attachments = ref<MessageAttachment[]>([])
const error = ref(false)
let request = 0

async function load(): Promise<void> {
  const current = ++request
  attachments.value = []
  error.value = false
  try {
    const res = await fetch(`/api/messages/${props.messageId}/attachments`)
    if (!res.ok) throw new Error(`Fehler ${res.status}`)
    const body = (await res.json()) as MessageAttachmentListResponse
    if (current === request) attachments.value = body.attachments.filter((a) => !a.inline)
  } catch {
    if (current === request) error.value = true
  }
}

function url(attachment: MessageAttachment, inline = false): string {
  return `/api/messages/${props.messageId}/attachments/${attachment.index}${inline ? '?inline=1' : ''}`
}

watch(() => props.messageId, load, { immediate: true })
</script>

<template>
  <section v-if="attachments.length > 0 || error" class="attachments" aria-label="Anhänge">
    <p v-if="error" class="hint">Anhänge konnten nicht geladen werden (offline?).</p>
    <ul v-else>
      <li v-for="attachment in attachments" :key="attachment.index">
        <span class="name" :title="attachment.filename">{{ attachment.filename }}</span>
        <span class="size">{{ formatByteSize(attachment.size) }}</span>
        <a
          v-if="isInlineSafeType(attachment.contentType)"
          :href="url(attachment, true)"
          target="_blank"
          rel="noopener noreferrer"
          >Ansehen</a
        >
        <a :href="url(attachment)" :download="attachment.filename">Herunterladen</a>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.attachments {
  margin-top: 0.75rem;
  padding-top: 0.5rem;
  border-top: 1px solid #e4e9ee;
  font-size: 0.85rem;
}

ul {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

li {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.25rem 0.75rem;
}

.name {
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}

.size {
  color: #52606d;
}

a {
  color: #1d4ed8;
}

.hint {
  margin: 0;
  color: #52606d;
}
</style>
