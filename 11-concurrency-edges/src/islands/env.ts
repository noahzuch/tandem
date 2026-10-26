// Per-document settings the island NodeViews read (set by App.vue before the editor renders).
export const islandEnv = {
  /** the document's own <style> text from <head>, injected into every island's shadow root */
  docCss: '',
  /**
   * spike 07: called with the key of the island the user is editing in (focus inside its shadow root),
   * and with null when they leave. App.vue publishes it through awareness as a soft lock, which the agent
   * CLI honours before rewriting an island (an island is ONE attribute: concurrent edits are last-writer-wins).
   */
  onEditing: null as ((key: string | null) => void) | null,
  /** spike 06: "comment" button in the island bar → composer for the whole island, or for the focused label (leaf) */
  onComment: null as ((pos: number, leaf: { path: string; text: string } | null) => void) | null,
}

/** all <style> contents of an HTML shell (doctype + head) */
export function extractCss(head: string): string {
  return Array.from(head.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi))
    .map((m) => m[1])
    .join('\n')
}

/**
 * Identity of an island for the soft lock: its opening tag (`<figure class="diagram">`, `<x-agent-note …>`,
 * `<!--`). Stable while the user edits text inside; the same rule runs in the browser and in the agent CLI.
 */
export function islandKey(html: string): string {
  const t = html.trimStart()
  if (t.startsWith('<!--')) return '<!--'
  return /^<[^>]*>/.exec(t)?.[0] ?? t.slice(0, 40)
}
