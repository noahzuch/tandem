// Small reactive UI state shared by toolbar, menus, dialogs (no Pinia needed for a spike).
import { reactive } from 'vue'

export interface DialogField {
  name: string
  label: string
  value?: string
  placeholder?: string
  multiline?: boolean
}
export interface DialogSpec {
  title: string
  fields: DialogField[]
  submit?: string
  resolve: (values: Record<string, string> | null) => void
}

export const ui = reactive({
  /** link popover in edit mode (⌘K / toolbar / bubble) */
  linkEdit: false,
  helpOpen: false,
  dialog: null as DialogSpec | null,
  toast: '',
  outlineOpen: true,
})

let toastTimer: ReturnType<typeof setTimeout> | undefined
export function toast(msg: string) {
  ui.toast = msg
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (ui.toast = ''), 2600)
}

/** promise-based replacement for window.prompt (styled, multi-field, testable) */
export function openDialog(spec: Omit<DialogSpec, 'resolve'>): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    ui.dialog = { ...spec, resolve }
  })
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

/** 'Mod-Shift-8' → '⌘⇧8' (mac) / 'Ctrl+Shift+8' */
export function formatShortcut(s: string | undefined): string {
  if (!s) return ''
  const parts = s.split('-').map((p) => (p === '' ? '-' : p))
  const map: Record<string, [string, string]> = {
    Mod: ['⌘', 'Ctrl'],
    Shift: ['⇧', 'Shift'],
    Alt: ['⌥', 'Alt'],
    Ctrl: ['⌃', 'Ctrl'],
    ArrowUp: ['↑', '↑'],
    ArrowDown: ['↓', '↓'],
    Enter: ['↵', 'Enter'],
    Backspace: ['⌫', 'Backspace'],
    Escape: ['Esc', 'Esc'],
  }
  const out = parts.map((p) => (map[p] ? map[p][isMac ? 0 : 1] : p.length === 1 ? p.toUpperCase() : p))
  return isMac ? out.join('') : out.join('+')
}
