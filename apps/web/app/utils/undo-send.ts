// Undo-send window (#116), per device: seconds the composer waits before it
// submits a message to the outbox; 0 sends at once. Default 5 s.
import { parseUndoSendSeconds } from '@fma/shared'
import type { UndoSendSeconds } from '@fma/shared'

const KEY = 'fma.compose.undoSeconds'

function read(): UndoSendSeconds {
  try {
    return parseUndoSendSeconds(localStorage.getItem(KEY))
  } catch {
    return 5
  }
}

export const undoSendSeconds = ref<UndoSendSeconds>(import.meta.client ? read() : 5)

export function setUndoSendSeconds(seconds: UndoSendSeconds): void {
  undoSendSeconds.value = seconds
  try {
    localStorage.setItem(KEY, String(seconds))
  } catch {
    // Private mode: only for this session.
  }
}
