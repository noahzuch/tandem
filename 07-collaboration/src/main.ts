import { createApp } from 'vue'
import App from './App.vue'
import './editor.css'
import './islands.css'
import './collab.css'
import 'highlight.js/styles/github.css' // BSD-3-Clause theme for lowlight's hljs-* classes

// spike 07: the document name is needed before the editor exists (the Y.Doc/provider are created in setup)
export interface DocInfo {
  path: string
  name: string
  head: string
  mtimeMs: number
}
const info = (await (await fetch('/doc')).json()) as DocInfo

createApp(App, { info }).mount('#app')
