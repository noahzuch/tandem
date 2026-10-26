import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  // one copy of yjs in the browser (a second one breaks instanceof checks: "Yjs was already imported"),
  // and pre-bundle the collaboration deps up front so a verify run never hits a mid-run re-optimisation reload
  resolve: { dedupe: ['yjs', 'y-protocols'] },
  optimizeDeps: {
    include: ['yjs', 'y-protocols/awareness', '@tiptap/y-tiptap', '@hocuspocus/provider', '@tiptap/extension-collaboration', '@tiptap/extension-collaboration-caret', '@tiptap/extension-unique-id'],
  },
})
