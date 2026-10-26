// One command registry for toolbar, bubble menu, slash menu, block menu and the "?" help.
// Every UI surface renders from here, so labels, icons and shortcuts stay consistent.
import type { Component } from 'vue'
import type { Editor } from '@tiptap/core'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import { Fragment, type Node as PMNode } from '@tiptap/pm/model'
import {
  Bold, Italic, Underline, Strikethrough, Code, Highlighter, Subscript, Superscript, Link,
  Pilcrow, Heading1, Heading2, Heading3, Heading4, List, ListOrdered, ListTodo, Quote, SquareCode,
  Table, TriangleAlert, Info, ListCollapse, SquareDashed, Image, Minus, Undo2, Redo2,
  ArrowUpToLine, ArrowDownToLine, ArrowLeftToLine, ArrowRightToLine, Rows3, Columns3, Trash2,
  TableCellsMerge, TableCellsSplit, PanelTop, PanelLeft, ArrowUp, ArrowDown, Copy,
} from 'lucide-vue-next'
import { ui, openDialog } from '../ui/store'

export interface Cmd {
  id: string
  label: string
  icon?: Component
  /** Tiptap keymap notation, e.g. 'Mod-Shift-8' (display only — the keymap lives in the extensions) */
  shortcut?: string
  /** markdown-style input rule that produces the same result (shown in help + slash menu) */
  markdown?: string
  keywords?: string[]
  group: 'history' | 'mark' | 'block' | 'insert' | 'table' | 'move'
  run: (editor: Editor) => void
  isActive?: (editor: Editor) => boolean
  /** shown in the slash menu? (default: block + insert commands) */
  slash?: boolean | ((editor: Editor) => boolean)
}

const c = (e: Editor) => e.chain().focus()

/** an editable callout with one empty paragraph */
export const calloutContent = (kind: 'info' | 'warning') => ({
  type: 'callout',
  attrs: { htmlAttrs: { class: `callout ${kind}`, 'data-kind': kind } },
  content: [{ type: 'paragraph' }],
})

const DEFAULT_ISLAND = `<svg width="320" height="80" viewBox="0 0 320 80" xmlns="http://www.w3.org/2000/svg">
  <rect x="10" y="20" width="120" height="40" rx="6" fill="#eef3fb" stroke="#4a78c2"/>
  <text x="70" y="45" text-anchor="middle" font-family="system-ui" font-size="14">Client</text>
  <line x1="130" y1="40" x2="190" y2="40" stroke="#4a78c2" stroke-width="2"/>
  <rect x="190" y="20" width="120" height="40" rx="6" fill="#eef3fb" stroke="#4a78c2"/>
  <text x="250" y="45" text-anchor="middle" font-family="system-ui" font-size="14">Server</text>
</svg>`

export async function insertImage(editor: Editor) {
  const v = await openDialog({
    title: 'Insert image by URL',
    fields: [
      { name: 'src', label: 'Image URL', placeholder: 'https://… or data:image/…' },
      { name: 'alt', label: 'Alt text (describe the image)' },
    ],
    submit: 'Insert',
  })
  if (!v?.src) return void editor.commands.focus()
  c(editor).setImage({ src: v.src, alt: v.alt || undefined }).run()
}

export async function insertIsland(editor: Editor) {
  const v = await openDialog({
    title: 'Insert raw HTML island',
    fields: [{ name: 'html', label: 'HTML kept verbatim (SVG, diagrams, embeds). Text leaves stay editable in place.', value: DEFAULT_ISLAND, multiline: true }],
    submit: 'Insert',
  })
  if (!v?.html?.trim()) return void editor.commands.focus()
  c(editor).insertContent({ type: 'htmlIsland', attrs: { html: v.html.trim() } }).run()
}

export function insertDetails(editor: Editor) {
  c(editor)
    .insertContent({ type: 'details', attrs: { open: true }, content: [{ type: 'detailsSummary' }, { type: 'paragraph' }] })
    .run()
}

export function insertTable(editor: Editor, rows = 3, cols = 3) {
  c(editor).insertTable({ rows, cols, withHeaderRow: true }).run()
}

// ------------------------------------------------------------------ move / duplicate blocks (keyboard drag alternative)
/** the block the user means: selected node, the list item around the caret, or the caret's textblock */
export function currentBlock(editor: Editor): { pos: number; depth: number } | null {
  const { selection, doc } = editor.state
  if (selection instanceof NodeSelection) {
    const $p = doc.resolve(selection.from)
    return { pos: selection.from, depth: $p.depth + 1 }
  }
  const $f = selection.$from
  let d = $f.depth
  if (d < 1) return null
  if (d > 1 && ['listItem', 'taskItem'].includes($f.node(d - 1).type.name)) d--
  if ($f.node(d - 1).type.spec.tableRole) {
    // inside a table cell: move the whole table
    while (d > 0 && $f.node(d).type.name !== 'table') d--
    if (d < 1) return null
  }
  return { pos: $f.before(d), depth: d }
}

export function moveBlock(editor: Editor, dir: -1 | 1): boolean {
  const b = currentBlock(editor)
  if (!b) return false
  const { state } = editor
  const $p = state.doc.resolve(b.pos)
  const node = state.doc.nodeAt(b.pos)!
  const parent = $p.parent
  const index = $p.index()
  const sibIndex = index + dir
  if (sibIndex < 0 || sibIndex >= parent.childCount) return false
  const sib = parent.child(sibIndex)
  const target = dir < 0 ? b.pos - sib.nodeSize : b.pos + sib.nodeSize
  const sel = state.selection
  const tr = state.tr.delete(b.pos, b.pos + node.nodeSize).insert(target, node)
  const delta = target - b.pos // same formula for both directions (target is in post-delete coordinates)
  if (sel instanceof NodeSelection) tr.setSelection(NodeSelection.create(tr.doc, target))
  else tr.setSelection(TextSelection.create(tr.doc, sel.anchor + delta, sel.head + delta))
  editor.view.dispatch(tr.scrollIntoView())
  return true
}

/** copy of a node without `id` attributes anywhere inside (a duplicated heading must not duplicate its anchor) */
function withoutIds(node: PMNode): PMNode {
  const content = Fragment.from(Array.from({ length: node.childCount }, (_, i) => withoutIds(node.child(i))))
  const ha = node.attrs.htmlAttrs as Record<string, string> | null | undefined
  if (!ha?.id) return node.isText ? node : node.copy(content)
  const { id: _drop, ...rest } = ha
  return node.type.create({ ...node.attrs, htmlAttrs: Object.keys(rest).length ? rest : null }, content, node.marks)
}

export function duplicateBlock(editor: Editor): boolean {
  const b = currentBlock(editor)
  if (!b) return false
  const node = editor.state.doc.nodeAt(b.pos)!
  editor.view.dispatch(editor.state.tr.insert(b.pos + node.nodeSize, withoutIds(node)).scrollIntoView())
  return true
}

export function deleteBlock(editor: Editor): boolean {
  const b = currentBlock(editor)
  if (!b) return false
  const node = editor.state.doc.nodeAt(b.pos)!
  editor.view.dispatch(editor.state.tr.delete(b.pos, b.pos + node.nodeSize).scrollIntoView())
  editor.commands.focus()
  return true
}

const inTable = (e: Editor) => e.isActive('table')

export const commands: Cmd[] = [
  // history
  { id: 'undo', group: 'history', label: 'Undo', icon: Undo2, shortcut: 'Mod-z', run: (e) => c(e).undo().run() },
  { id: 'redo', group: 'history', label: 'Redo', icon: Redo2, shortcut: 'Mod-Shift-z', run: (e) => c(e).redo().run() },
  // marks
  { id: 'bold', group: 'mark', label: 'Bold', icon: Bold, shortcut: 'Mod-b', markdown: '**text**', run: (e) => c(e).toggleBold().run(), isActive: (e) => e.isActive('bold') },
  { id: 'italic', group: 'mark', label: 'Italic', icon: Italic, shortcut: 'Mod-i', markdown: '*text*', run: (e) => c(e).toggleItalic().run(), isActive: (e) => e.isActive('italic') },
  { id: 'underline', group: 'mark', label: 'Underline', icon: Underline, shortcut: 'Mod-u', run: (e) => c(e).toggleUnderline().run(), isActive: (e) => e.isActive('underline') },
  { id: 'strike', group: 'mark', label: 'Strikethrough', icon: Strikethrough, shortcut: 'Mod-Shift-s', markdown: '~~text~~', run: (e) => c(e).toggleStrike().run(), isActive: (e) => e.isActive('strike') },
  { id: 'code', group: 'mark', label: 'Inline code', icon: Code, shortcut: 'Mod-e', markdown: '`code`', run: (e) => c(e).toggleCode().run(), isActive: (e) => e.isActive('code') },
  { id: 'highlight', group: 'mark', label: 'Highlight', icon: Highlighter, shortcut: 'Mod-Shift-h', markdown: '==text==', run: (e) => c(e).toggleHighlight().run(), isActive: (e) => e.isActive('highlight') },
  { id: 'sub', group: 'mark', label: 'Subscript', icon: Subscript, shortcut: 'Mod-,', run: (e) => c(e).toggleSubscript().run(), isActive: (e) => e.isActive('subscript') },
  { id: 'sup', group: 'mark', label: 'Superscript', icon: Superscript, shortcut: 'Mod-.', run: (e) => c(e).toggleSuperscript().run(), isActive: (e) => e.isActive('superscript') },
  { id: 'link', group: 'mark', label: 'Link', icon: Link, shortcut: 'Mod-k', run: () => (ui.linkEdit = true), isActive: (e) => e.isActive('link') },
  // block types ("turn into")
  { id: 'paragraph', group: 'block', label: 'Text', icon: Pilcrow, shortcut: 'Mod-Alt-0', keywords: ['paragraph', 'plain'], run: (e) => c(e).setParagraph().run(), isActive: (e) => e.isActive('paragraph') && !e.isActive('bulletList') && !e.isActive('orderedList') && !e.isActive('taskList') && !e.isActive('blockquote') },
  { id: 'h1', group: 'block', label: 'Heading 1', icon: Heading1, shortcut: 'Mod-Alt-1', markdown: '# ', keywords: ['title', 'h1'], run: (e) => c(e).setHeading({ level: 1 }).run(), isActive: (e) => e.isActive('heading', { level: 1 }) },
  { id: 'h2', group: 'block', label: 'Heading 2', icon: Heading2, shortcut: 'Mod-Alt-2', markdown: '## ', keywords: ['section', 'h2'], run: (e) => c(e).setHeading({ level: 2 }).run(), isActive: (e) => e.isActive('heading', { level: 2 }) },
  { id: 'h3', group: 'block', label: 'Heading 3', icon: Heading3, shortcut: 'Mod-Alt-3', markdown: '### ', keywords: ['subsection', 'h3'], run: (e) => c(e).setHeading({ level: 3 }).run(), isActive: (e) => e.isActive('heading', { level: 3 }) },
  { id: 'h4', group: 'block', label: 'Heading 4', icon: Heading4, shortcut: 'Mod-Alt-4', markdown: '#### ', keywords: ['h4'], run: (e) => c(e).setHeading({ level: 4 }).run(), isActive: (e) => e.isActive('heading', { level: 4 }) },
  { id: 'bulletList', group: 'block', label: 'Bullet list', icon: List, shortcut: 'Mod-Shift-8', markdown: '- ', keywords: ['ul', 'unordered'], run: (e) => c(e).toggleBulletList().run(), isActive: (e) => e.isActive('bulletList') },
  { id: 'orderedList', group: 'block', label: 'Numbered list', icon: ListOrdered, shortcut: 'Mod-Shift-7', markdown: '1. ', keywords: ['ol', 'ordered'], run: (e) => c(e).toggleOrderedList().run(), isActive: (e) => e.isActive('orderedList') },
  { id: 'taskList', group: 'block', label: 'Task list', icon: ListTodo, shortcut: 'Mod-Shift-9', markdown: '[ ] or - [ ] ', keywords: ['todo', 'checkbox', 'checklist'], run: (e) => c(e).toggleTaskList().run(), isActive: (e) => e.isActive('taskList') },
  { id: 'blockquote', group: 'block', label: 'Quote', icon: Quote, shortcut: 'Mod-Shift-b', markdown: '> ', keywords: ['blockquote', 'cite'], run: (e) => c(e).toggleBlockquote().run(), isActive: (e) => e.isActive('blockquote') },
  { id: 'codeBlock', group: 'block', label: 'Code block', icon: SquareCode, shortcut: 'Mod-Alt-c', markdown: '``` ', keywords: ['pre', 'snippet', 'source'], run: (e) => c(e).toggleCodeBlock().run(), isActive: (e) => e.isActive('codeBlock') },
  // insert
  { id: 'table', group: 'insert', label: 'Table', icon: Table, keywords: ['grid', 'matrix'], run: (e) => insertTable(e), slash: (e) => !inTable(e) },
  { id: 'callout', group: 'insert', label: 'Callout', icon: Info, keywords: ['note', 'info', 'box', 'admonition'], run: (e) => c(e).insertContent(calloutContent('info')).run() },
  { id: 'calloutWarning', group: 'insert', label: 'Warning callout', icon: TriangleAlert, keywords: ['decision', 'warning', 'caution', 'box'], run: (e) => c(e).insertContent(calloutContent('warning')).run() },
  { id: 'details', group: 'insert', label: 'Details (collapsible)', icon: ListCollapse, keywords: ['toggle', 'summary', 'collapse', 'appendix'], run: insertDetails },
  { id: 'hr', group: 'insert', label: 'Divider', icon: Minus, markdown: '--- ', keywords: ['hr', 'rule', 'separator'], run: (e) => c(e).setHorizontalRule().run() },
  { id: 'image', group: 'insert', label: 'Image by URL', icon: Image, keywords: ['picture', 'img', 'screenshot'], run: (e) => void insertImage(e) },
  { id: 'island', group: 'insert', label: 'Raw HTML island', icon: SquareDashed, keywords: ['svg', 'diagram', 'embed', 'html', 'raw'], run: (e) => void insertIsland(e) },
  // table (slash menu only inside a table; also in the table menu)
  { id: 'addRowBefore', group: 'table', label: 'Row above', icon: ArrowUpToLine, keywords: ['table', 'insert row'], run: (e) => c(e).addRowBefore().run(), slash: inTable },
  { id: 'addRowAfter', group: 'table', label: 'Row below', icon: ArrowDownToLine, keywords: ['table', 'insert row'], run: (e) => c(e).addRowAfter().run(), slash: inTable },
  { id: 'deleteRow', group: 'table', label: 'Delete row', icon: Rows3, keywords: ['table', 'remove row'], run: (e) => c(e).deleteRow().run(), slash: inTable },
  { id: 'addColumnBefore', group: 'table', label: 'Column left', icon: ArrowLeftToLine, keywords: ['table', 'insert column'], run: (e) => c(e).addColumnBefore().run(), slash: inTable },
  { id: 'addColumnAfter', group: 'table', label: 'Column right', icon: ArrowRightToLine, keywords: ['table', 'insert column'], run: (e) => c(e).addColumnAfter().run(), slash: inTable },
  { id: 'deleteColumn', group: 'table', label: 'Delete column', icon: Columns3, keywords: ['table', 'remove column'], run: (e) => c(e).deleteColumn().run(), slash: inTable },
  { id: 'mergeCells', group: 'table', label: 'Merge cells', icon: TableCellsMerge, keywords: ['table', 'colspan'], run: (e) => c(e).mergeCells().run(), slash: false },
  { id: 'splitCell', group: 'table', label: 'Split cell', icon: TableCellsSplit, keywords: ['table', 'unmerge'], run: (e) => c(e).splitCell().run(), slash: inTable },
  { id: 'toggleHeaderRow', group: 'table', label: 'Header row', icon: PanelTop, keywords: ['table', 'th'], run: (e) => c(e).toggleHeaderRow().run(), slash: inTable },
  { id: 'toggleHeaderColumn', group: 'table', label: 'Header column', icon: PanelLeft, keywords: ['table', 'th'], run: (e) => c(e).toggleHeaderColumn().run(), slash: inTable },
  { id: 'deleteTable', group: 'table', label: 'Delete table', icon: Trash2, keywords: ['table', 'remove'], run: (e) => c(e).deleteTable().run(), slash: inTable },
  // move
  { id: 'moveUp', group: 'move', label: 'Move block up', icon: ArrowUp, shortcut: 'Alt-Shift-ArrowUp', run: (e) => moveBlock(e, -1), slash: false },
  { id: 'moveDown', group: 'move', label: 'Move block down', icon: ArrowDown, shortcut: 'Alt-Shift-ArrowDown', run: (e) => moveBlock(e, 1), slash: false },
  { id: 'duplicate', group: 'move', label: 'Duplicate block', icon: Copy, shortcut: 'Mod-Shift-d', run: (e) => duplicateBlock(e), slash: false },
  { id: 'deleteBlock', group: 'move', label: 'Delete block', icon: Trash2, run: (e) => deleteBlock(e), slash: false },
]

export const cmd = (id: string): Cmd => {
  const found = commands.find((x) => x.id === id)
  if (!found) throw new Error(`unknown command ${id}`)
  return found
}

export const slashCommands = (editor: Editor) =>
  commands.filter((x) => {
    const s = x.slash ?? (x.group === 'block' || x.group === 'insert')
    return typeof s === 'function' ? s(editor) : s
  })
