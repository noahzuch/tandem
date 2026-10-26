import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  // one copy of yjs in the browser (a second one breaks instanceof checks: "Yjs was already imported"),
  // and pre-bundle the collaboration deps up front so a verify run never hits a mid-run re-optimisation reload
  // spike 08: the default doc lives in .work/ inside the Vite root. Without this, every store (the server writing
  // .work/spec.html) made Vite full-reload the page under `npm start` → the user's keystrokes went into a reloading page.
  server: { watch: { ignored: ['**/.work/**', '**/.collab/**'] } },
  resolve: { dedupe: ['yjs', 'y-protocols'] },
  optimizeDeps: {
    include: ['yjs', 'y-protocols/awareness', '@tiptap/y-tiptap', '@hocuspocus/provider', '@tiptap/extension-collaboration', '@tiptap/extension-collaboration-caret', '@tiptap/extension-unique-id'],
  },
})
