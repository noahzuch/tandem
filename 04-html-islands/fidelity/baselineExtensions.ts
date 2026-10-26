// BASELINE for npm run fidelity: spike 02's extension list, copied verbatim (the "before" column).
// so both measure exactly the same schema.
import type { Extensions } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit' // v3: includes Link, Underline, ListKeymap, TrailingNode, UndoRedo
import { TableKit } from '@tiptap/extension-table' // Table, TableRow, TableHeader, TableCell
import { TaskList, TaskItem } from '@tiptap/extension-list'
import Image from '@tiptap/extension-image'
import Highlight from '@tiptap/extension-highlight'
import TextAlign from '@tiptap/extension-text-align'
import Typography from '@tiptap/extension-typography'
import { Placeholder } from '@tiptap/extensions'

export function buildExtensions(): Extensions {
  return [
    StarterKit.configure({
      link: { openOnClick: false, autolink: true },
    }),
    TableKit.configure({ table: { resizable: false } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Image,
    Highlight.configure({ multicolor: true }),
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    Typography,
    Placeholder.configure({ placeholder: 'Start writing the spec…' }),
  ]
}
