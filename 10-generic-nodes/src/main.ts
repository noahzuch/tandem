import { createApp } from 'vue'
import App from './App.vue'
import './editor.css'
import './islands.css'
import './collab.css'
import 'highlight.js/styles/github.css' // BSD-3-Clause theme for lowlight's hljs-* classes
import './generic.css'
import { setPolicyPreset, policy } from './generic/policy'

// spike 07: the document name is needed before the editor exists (the Y.Doc/provider are created in setup)
export interface DocInfo {
  path: string
  name: string
  head: string
  body: string
  mtimeMs: number
  /** spike 10: the server's policy preset + svg experiment flag (URL params override per tab) */
  mode: string
  svg: 'island' | 'nodes'
  shape: 'inline' | 'block'
}
const info = (await (await fetch('/doc')).json()) as DocInfo
// spike 10: the policy must be set before anything is parsed (server-side seeding used the server's flags;
// a tab that overrides them only affects what IT parses: pasted HTML, ?collab=0 loads, __load() in tests)
const params = new URLSearchParams(location.search)
setPolicyPreset(params.get('mode') ?? info.mode)
policy.svg = (params.get('svg') as 'island' | 'nodes' | null) ?? info.svg
// round 2 switches: ?isolating=0 (measure the isolating trade-off), ?shape=block (Enter variant (a): block+ textblocks)
policy.isolating = params.get('isolating') !== '0'
policy.textblocks = (params.get('shape') ?? info.shape) === 'block' ? 'block' : 'inline'

createApp(App, { info }).mount('#app')
