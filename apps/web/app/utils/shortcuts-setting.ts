// Keyboard shortcuts on/off (#115), per device: a keyboard layout is a
// property of the device, not of the account. Default on.
const KEY = 'fma.shortcuts.enabled'

function read(): boolean {
  try {
    return localStorage.getItem(KEY) !== '0'
  } catch {
    return true
  }
}

export const shortcutsEnabled = ref(import.meta.client ? read() : true)

export function setShortcutsEnabled(enabled: boolean): void {
  shortcutsEnabled.value = enabled
  try {
    localStorage.setItem(KEY, enabled ? '1' : '0')
  } catch {
    // Private mode: only for this session.
  }
}

/** The event comes from a text field (shortcuts are inactive there). */
export function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  if (element && /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName)) return true
  return !!element?.isContentEditable
}
