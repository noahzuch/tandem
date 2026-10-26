// One extension list shared by the Vue app (browser) and the fidelity script (Node),
// so both measure exactly the same schema. Spike 04 = spike 02's list + everything below "spike 04".
import { Extension, Mark, Node, mergeAttributes, type Extensions, type NodeViewRenderer } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit' // v3: includes Link, Underline, ListKeymap, TrailingNode, UndoRedo
import { TableKit } from '@tiptap/extension-table'
import { TaskList, TaskItem } from '@tiptap/extension-list'
import Image from '@tiptap/extension-image'
import Highlight from '@tiptap/extension-highlight'
import TextAlign from '@tiptap/extension-text-align'
import Typography from '@tiptap/extension-typography'
import { Placeholder, CharacterCount } from '@tiptap/extensions'
// spike 04 (all MIT)
import Code from '@tiptap/extension-code'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import { createLowlight, common } from 'lowlight'
import Subscript from '@tiptap/extension-subscript'
import Superscript from '@tiptap/extension-superscript'
import { TextStyle, Color, BackgroundColor } from '@tiptap/extension-text-style'
// spike 07 (all MIT)
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import UniqueID from '@tiptap/extension-unique-id'
import { UndoManager, type Doc as YDoc } from 'yjs'
import { defaultDeleteFilter, defaultProtectedNodes, ySyncPluginKey } from '@tiptap/y-tiptap'
import { classify, domEl } from './islands/classify'
import { ISLAND_ATTR } from './islands/raw'
import { AgentHighlight, type AgentHighlightOptions } from './editor/agentHighlight'

// ---------------------------------------------------------------- spike 07: block ids
/**
 * Every addressable block carries a short stable id (`data-bid="k3f9ax"` in the HTML). The agent CLI uses
 * it for `set-block`, the browser uses it to tell "block changed" from "block moved" when a remote update
 * arrives. Islands are excluded (their placeholder is `<div data-raw-island>` and must stay attribute-free),
 * so are list items / table rows (too noisy in the file).
 */
export const BLOCK_ID_ATTR = 'bid'
export const BLOCK_ID_TYPES = ['paragraph', 'heading', 'bulletList', 'orderedList', 'taskList', 'blockquote', 'codeBlock', 'table', 'callout', 'container', 'details']
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
export function generateBlockId(): string {
  let s = ''
  for (let i = 0; i < 6; i++) s += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)]
  return s
}

// ---------------------------------------------------------------- attribute preservation
/** Attributes no node should ever store (editor-internal). */
const NEVER = new Set(['contenteditable', 'draggable', ISLAND_ATTR, 'data-pm-slice', `data-${BLOCK_ID_ATTR}`])

interface AttrPolicy {
  /** attribute names the node type already models itself (don't store twice) */
  skip?: string[]
  /** CSS properties the node type renders itself (stripped from a stored style) */
  styleSkip?: string[]
}

/** collect all attributes of an element (minus policy) in source order; null if none */
export function collectAttrs(el: Element, policy: AttrPolicy = {}): Record<string, string> | null {
  const out: Record<string, string> = {}
  for (const a of Array.from(el.attributes)) {
    if (NEVER.has(a.name) || policy.skip?.includes(a.name)) continue
    // security policy: event handlers would run in the editor (nodes render as live DOM) → dropped.
    // Agent HTML that needs them belongs in an island (kept verbatim, never executed in the editor).
    if (/^on/i.test(a.name)) continue
    let value = a.value
    if (a.name === 'style' && policy.styleSkip?.length) {
      value = value
        .split(';')
        .map((d) => d.trim())
        .filter((d) => d && !policy.styleSkip!.includes(d.split(':')[0].trim().toLowerCase()))
        .join('; ')
      if (!value) continue
    }
    out[a.name] = value
  }
  return Object.keys(out).length ? out : null
}

const ALIGN = ['text-align']
/** Every node/mark type that keeps its unknown attributes (id, class, data-*, style, title, lang, …). */
const ATTR_POLICY: Record<string, AttrPolicy> = {
  paragraph: { styleSkip: ALIGN },
  heading: { styleSkip: ALIGN },
  blockquote: {},
  bulletList: {},
  orderedList: { skip: ['start', 'type'] },
  listItem: {},
  taskList: { skip: ['data-type'] },
  taskItem: { skip: ['data-type', 'data-checked'] },
  codeBlock: {},
  horizontalRule: {},
  image: { skip: ['src', 'alt', 'title', 'width', 'height'] },
  table: { styleSkip: ['width', 'min-width'] },
  tableRow: {},
  tableCell: { skip: ['colspan', 'rowspan', 'colwidth'], styleSkip: ALIGN },
  tableHeader: { skip: ['colspan', 'rowspan', 'colwidth'], styleSkip: ALIGN },
  callout: {},
  container: {},
  details: { skip: ['open'] },
  detailsSummary: {},
  hardBreak: {},
  link: { skip: ['href', 'target', 'rel', 'title', 'class'] },
  bold: {},
  italic: {},
  underline: {},
  strike: {},
  code: {},
  subscript: {},
  superscript: {},
  highlight: { skip: ['data-color', 'style'] },
  textStyle: { skip: ['style'] },
}

export const PreserveAttributes = Extension.create({
  name: 'preserveAttributes',
  addGlobalAttributes() {
    return Object.entries(ATTR_POLICY).map(([type, policy]) => ({
      types: [type],
      attributes: {
        htmlAttrs: {
          default: null,
          keepOnSplit: false, // Enter in a heading must not duplicate its id
          parseHTML: (el: HTMLElement) => collectAttrs(el, policy),
          renderHTML: (attrs: Record<string, unknown>) => (attrs.htmlAttrs as Record<string, string>) ?? {},
        },
      },
    }))
  },
})

// ---------------------------------------------------------------- raw HTML islands
const islandAttrs = {
  html: {
    default: '',
    // placeholder from prepareForEditor (byte-exact source) or, fallback, DOM-normalised outerHTML
    parseHTML: (el: HTMLElement) => el.getAttribute(ISLAND_ATTR) ?? el.outerHTML,
    rendered: false,
  },
}

export interface IslandOptions {
  view: NodeViewRenderer | null
}

export const HtmlIsland = Node.create<IslandOptions>({
  name: 'htmlIsland',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,
  addOptions: () => ({ view: null }),
  addAttributes: () => islandAttrs,
  parseHTML() {
    return [
      { tag: `div[${ISLAND_ATTR}]`, priority: 1000 },
      // fallback: anything the schema can't model (see islands/classify.ts)
      { tag: '*', priority: 1, getAttrs: (el) => (classify(domEl(el)) === 'block' ? null : false) },
    ]
  },
  renderHTML: ({ node }) => ['div', { [ISLAND_ATTR]: node.attrs.html }],
  addNodeView() {
    return this.options.view
  },
})

export const HtmlIslandInline = Node.create<IslandOptions>({
  name: 'htmlIslandInline',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,
  addOptions: () => ({ view: null }),
  addAttributes: () => islandAttrs,
  parseHTML() {
    return [
      { tag: `span[${ISLAND_ATTR}]`, priority: 1000 },
      { tag: '*', priority: 1, getAttrs: (el) => (classify(domEl(el)) === 'inline' ? null : false) },
    ]
  },
  renderHTML: ({ node }) => ['span', { [ISLAND_ATTR]: node.attrs.html }],
  addNodeView() {
    return this.options.view
  },
})

// ---------------------------------------------------------------- editable containers
/** <div class="callout …">: an editable box; kind lives in class / data-kind (kept by PreserveAttributes) */
export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,
  parseHTML: () => [{ tag: 'div.callout', priority: 60 }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes({ class: 'callout' }, HTMLAttributes), 0],
})

const CONTAINER_TAGS = ['section', 'article', 'header', 'footer', 'aside', 'main', 'nav', 'address', 'hgroup', 'div']

/** Generic wrapper: keeps tag + attributes (incl. style → grid layouts render) with editable blocks inside. */
export const Container = Node.create({
  name: 'container',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes: () => ({ tag: { default: 'div', parseHTML: (el: HTMLElement) => el.localName, rendered: false } }),
  parseHTML() {
    return CONTAINER_TAGS.map((tag) => ({
      tag,
      priority: 40,
      getAttrs: (el: HTMLElement) =>
        tag === 'div' &&
        (el.hasAttribute('data-type') || el.hasAttribute(ISLAND_ATTR) || el.parentElement?.matches('li[data-type="taskItem"]'))
          ? false
          : null,
    }))
  },
  renderHTML: ({ node, HTMLAttributes }) => [node.attrs.tag, HTMLAttributes, 0],
})

export const DetailsSummary = Node.create({
  name: 'detailsSummary',
  content: 'inline*',
  defining: true,
  parseHTML: () => [{ tag: 'summary' }],
  renderHTML: ({ HTMLAttributes }) => ['summary', HTMLAttributes, 0],
})

/** <details open?><summary>…</summary>blocks</details>. In the editor always expanded (toggle = attribute). */
export const Details = Node.create({
  name: 'details',
  group: 'block',
  content: 'detailsSummary block+',
  defining: true,
  addAttributes: () => ({
    open: {
      default: true,
      parseHTML: (el: HTMLElement) => el.hasAttribute('open'),
      renderHTML: (a: Record<string, unknown>) => (a.open ? { open: '' } : {}),
    },
  }),
  parseHTML: () => [{ tag: 'details' }],
  renderHTML: ({ HTMLAttributes }) => ['details', HTMLAttributes, 0],
  addNodeView() {
    return ({ node, getPos, editor }) => {
      let current = node
      const dom = document.createElement('div')
      dom.className = 'pm-details'
      const toggle = document.createElement('button')
      toggle.type = 'button'
      toggle.contentEditable = 'false'
      toggle.className = 'pm-details-toggle'
      toggle.dataset.testid = 'details-toggle'
      const sync = () => {
        dom.dataset.open = String(!!current.attrs.open)
        toggle.textContent = current.attrs.open ? '▾ open' : '▸ closed'
        toggle.title = 'Toggle whether this <details> is open in the saved file'
      }
      toggle.addEventListener('mousedown', (e) => e.preventDefault())
      toggle.addEventListener('click', () => {
        const pos = typeof getPos === 'function' ? getPos() : undefined
        if (pos == null) return
        editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, open: !current.attrs.open }))
      })
      const contentDOM = document.createElement('div')
      contentDOM.className = 'pm-details-content'
      dom.append(toggle, contentDOM)
      sync()
      return {
        dom,
        contentDOM,
        update: (n) => {
          if (n.type !== current.type) return false
          current = n
          sync()
          return true
        },
        stopEvent: (e) => toggle.contains(e.target as globalThis.Node),
        ignoreMutation: (m) => toggle.contains(m.target),
      }
    }
  },
})

// ---------------------------------------------------------------- generic inline elements
const INLINE_TAGS = ['small', 'abbr', 'kbd', 'ins', 'cite', 'q', 'dfn', 'var', 'samp', 'time', 'bdi', 'bdo', 'data', 'font', 'big', 'tt']

/** Phrasing elements without their own mark: keeps tag + all attributes; may nest (<small><abbr>). */
export const InlineTag = Mark.create({
  name: 'inlineTag',
  excludes: '',
  addAttributes: () => ({
    tag: { default: 'span', parseHTML: (el: HTMLElement) => el.localName, rendered: false },
    attrs: { default: null, parseHTML: (el: HTMLElement) => collectAttrs(el), rendered: false },
  }),
  parseHTML: () => [
    ...INLINE_TAGS.map((tag) => ({ tag })),
    // styled spans belong to TextStyle (which keeps class/data-* via PreserveAttributes)
    { tag: 'span', getAttrs: (el: HTMLElement) => (el.hasAttribute('style') || el.hasAttribute(ISLAND_ATTR) ? false : null) },
  ],
  renderHTML: ({ mark }) => [mark.attrs.tag, mark.attrs.attrs ?? {}, 0],
})

// ---------------------------------------------------------------- tweaked built-ins
/** keeps attributes of the inner <code> (lang-js, data-language…) */
export const lowlight = createLowlight(common)

/** spike 05: CodeBlockLowlight (syntax highlighting via decorations, nothing written to the HTML) */
const CodeBlockX = CodeBlockLowlight.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      codeAttrs: {
        default: null,
        rendered: false,
        parseHTML: (el: HTMLElement) => {
          const code = el.firstElementChild?.localName === 'code' ? el.firstElementChild : null
          const a = code ? collectAttrs(code) : null
          if (a?.class) {
            const rest = a.class.split(/\s+/).filter((c) => c && !c.startsWith('language-'))
            if (rest.length) a.class = rest.join(' ')
            else delete a.class
          }
          return a && Object.keys(a).length ? a : null
        },
      },
    }
  },
  renderHTML({ node, HTMLAttributes }) {
    const lang = node.attrs.language ? this.options.languageClassPrefix + node.attrs.language : null
    return ['pre', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), ['code', mergeAttributes(node.attrs.codeAttrs ?? {}, lang ? { class: lang } : {}), 0]]
  },
})

/**
 * Our own Y.UndoManager (same settings as y-prosemirror's default), with `destroy()` disarmed.
 *
 * Found by verify (S5): redo never worked. Every `editor.registerPlugin()` (bubble menus, drag handle, link
 * popover… on mount) makes ProseMirror destroy and re-create all plugin views. y-prosemirror's undo plugin
 * view calls `undoManager.destroy()` on destroy, which removes the manager from its own `trackedOrigins`
 * (so undo transactions no longer land on the redo stack). Tiptap's Collaboration extension tries to
 * restore that on the next view(), but after the first cycle the restore no longer runs and the manager
 * stays untracked → `can().redo()` is always false. A manager that ignores destroy() sidesteps the churn.
 */
function collabUndoManager(document: YDoc): UndoManager {
  const um = new UndoManager(document.getXmlFragment('default'), {
    trackedOrigins: new Set([ySyncPluginKey]),
    deleteFilter: (item) => defaultDeleteFilter(item, defaultProtectedNodes),
    captureTransaction: (tr) => tr.meta.get('addToHistory') !== false,
  })
  um.destroy = () => {}
  return um
}

export interface CollabOptions {
  document: YDoc
  /** HocuspocusProvider (carets need its awareness) */
  provider: unknown
  user: { name: string; color: string }
  onFirstRender?: () => void
  highlight?: AgentHighlightOptions
}

export interface BuildOptions {
  islandView?: NodeViewRenderer
  /** spike 05: Vue NodeView for code blocks (language picker); browser only */
  codeBlockView?: NodeViewRenderer
  /** spike 05: UI-only extensions (slash menu, shortcuts, …); browser only */
  ui?: Extensions
  /** spike 07: bind the editor to a Y.Doc (browser only). Replaces StarterKit's undo/redo with Y.UndoManager. */
  collab?: CollabOptions
}

export function buildExtensions(opts: BuildOptions = {}): Extensions {
  return [
    StarterKit.configure({
      code: false,
      codeBlock: false,
      // spike 07: Collaboration brings its own history (Y.UndoManager, tracks only local origins)
      undoRedo: opts.collab ? false : undefined,
      dropcursor: { color: '#4a78c2', width: 2 }, // spike 05: visible drop target for the block drag handle
      // spike 02 finding: Link adds target=_blank rel=… to every link. Keep what the source has instead.
      link: { openOnClick: false, autolink: true, HTMLAttributes: { target: null, rel: null } },
    }),
    // spike 05: column resize on (only writes colwidth/style when the user actually drags a border)
    TableKit.configure({ table: { resizable: true, lastColumnResizable: false } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Image.configure({ inline: true, allowBase64: true }),
    Highlight.configure({ multicolor: true }),
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    // spike 05: no `--` → em dash: specs contain CLI flags (--port) and it breaks the `--- ` divider rule
    Typography.configure({ emDash: false }),
    Placeholder.configure({
      placeholder: ({ node }) =>
        node.type.name === 'heading' ? `Heading ${node.attrs.level}` : node.type.name === 'detailsSummary' ? 'Summary' : "Type '/' for commands…",
      includeChildren: true,
    }),
    CharacterCount, // spike 05: word/character count in the status bar
    // spike 04
    CodeBlockX.configure({ lowlight, defaultLanguage: null }).extend({
      addNodeView() {
        return opts.codeBlockView ?? null
      },
    }),
    TextStyle,
    Color,
    BackgroundColor,
    Subscript,
    Superscript,
    InlineTag,
    Code.extend({ excludes: '' }), // registered last → innermost mark, may combine with bold/italic
    Callout,
    Details,
    DetailsSummary,
    Container,
    HtmlIsland.configure({ view: opts.islandView ?? null }),
    HtmlIslandInline.configure({ view: opts.islandView ?? null }),
    PreserveAttributes,
    // spike 07: stable block ids. In the browser only local transactions create ids (remote ones already carry them).
    UniqueID.configure({
      attributeName: BLOCK_ID_ATTR,
      types: BLOCK_ID_TYPES,
      generateID: generateBlockId,
      filterTransaction: (tr) => !tr.getMeta('y-sync$'),
    }),
    ...(opts.collab
      ? [
          Collaboration.configure({ document: opts.collab.document, onFirstRender: opts.collab.onFirstRender, yUndoOptions: { undoManager: collabUndoManager(opts.collab.document) } }),
          CollaborationCaret.configure({ provider: opts.collab.provider, user: opts.collab.user }),
          AgentHighlight.configure(opts.collab.highlight ?? {}),
        ]
      : []),
    ...(opts.ui ?? []),
  ]
}
