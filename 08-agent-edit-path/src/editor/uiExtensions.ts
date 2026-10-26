// Browser-only extensions for spike 05's UI: slash menu, extra shortcuts, `- [ ] ` input rule.
import { Extension, InputRule } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'
import Suggestion, { type SuggestionProps, type SuggestionKeyDownProps } from '@tiptap/suggestion'
import { VueRenderer } from '@tiptap/vue-3'
import SlashMenu from '../ui/SlashMenu.vue'
import { slashCommands, moveBlock, duplicateBlock, type Cmd } from './commands'
import { ui } from '../ui/store'

export const slashKey = new PluginKey('slash')

function score(cmd: Cmd, q: string): number {
  if (!q) return 1
  const label = cmd.label.toLowerCase()
  if (label.startsWith(q)) return 3
  if (label.split(/\s+/).some((w) => w.startsWith(q))) return 2
  if (label.includes(q) || cmd.keywords?.some((k) => k.startsWith(q)) || cmd.id.toLowerCase().includes(q)) return 1
  return 0
}

/** `/` → filtered command list (Tiptap's slash-commands example pattern on the MIT Suggestion utility) */
export const SlashCommand = Extension.create({
  name: 'slashCommand',
  addProseMirrorPlugins() {
    return [
      Suggestion<Cmd, Cmd>({
        editor: this.editor,
        pluginKey: slashKey,
        char: '/',
        allowSpaces: false,
        startOfLine: false,
        // not inside code (paths like /sync), not in inline code
        allow: ({ state, range }) => {
          const $from = state.doc.resolve(range.from)
          if ($from.parent.type.spec.code) return false
          return !state.doc.rangeHasMark(range.from, range.to, state.schema.marks.code)
        },
        items: ({ query, editor }) => {
          const q = query.toLowerCase().trim()
          return slashCommands(editor)
            .map((cmd) => ({ cmd, s: score(cmd, q) }))
            .filter((x) => x.s > 0)
            .sort((a, b) => b.s - a.s)
            .map((x) => x.cmd)
            .slice(0, 30)
        },
        command: ({ editor, range, props }) => {
          editor.chain().focus().deleteRange(range).run()
          props.run(editor)
        },
        render: () => {
          let renderer: VueRenderer | null = null
          let unmount: (() => void) | null = null
          return {
            onStart: (props: SuggestionProps<Cmd, Cmd>) => {
              renderer = new VueRenderer(SlashMenu, { props, editor: props.editor })
              unmount = props.mount(renderer.element as HTMLElement)
            },
            onUpdate: (props: SuggestionProps<Cmd, Cmd>) => renderer?.updateProps(props),
            onKeyDown: (props: SuggestionKeyDownProps) => {
              return (renderer?.ref as { onKeyDown?: (e: KeyboardEvent) => boolean } | undefined)?.onKeyDown?.(props.event) ?? false
            },
            onExit: () => {
              unmount?.()
              unmount = null
              renderer?.destroy()
              renderer = null
            },
          }
        },
      }),
    ]
  },
})

/** shortcuts that belong to the UI layer, not to a node/mark extension */
export const UiShortcuts = Extension.create({
  name: 'uiShortcuts',
  addKeyboardShortcuts() {
    return {
      'Mod-k': () => {
        ui.linkEdit = true
        return true
      },
      'Mod-/': () => {
        ui.helpOpen = !ui.helpOpen
        return true
      },
      'Alt-Shift-ArrowUp': () => moveBlock(this.editor, -1),
      'Alt-Shift-ArrowDown': () => moveBlock(this.editor, 1),
      'Mod-Shift-d': () => duplicateBlock(this.editor),
    }
  },
})

/**
 * `- [ ] ` / `* [x] `: StarterKit turns `- ` into a bullet list first; TaskItem's own `[ ] ` rule would then nest a task
 * list *inside* the bullet item. This rule (higher priority) converts the bullet item into a task item instead.
 */
export const BulletToTask = Extension.create({
  name: 'bulletToTask',
  priority: 1000,
  addInputRules() {
    return [
      new InputRule({
        find: /^\s*\[([ xX]?)\]\s$/,
        handler: ({ state, range, match, chain }) => {
          const $from = state.doc.resolve(range.from)
          if ($from.depth < 2 || $from.node(-1).type.name !== 'listItem' || $from.node(-2).type.name !== 'bulletList') return null
          const checked = match[1]?.toLowerCase() === 'x'
          chain().deleteRange(range).toggleTaskList().updateAttributes('taskItem', { checked }).run()
        },
      }),
    ]
  },
})

export const uiExtensions = [SlashCommand, UiShortcuts, BulletToTask]
