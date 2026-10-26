// Per-document settings the island NodeViews read (set by App.vue before setContent).
export const islandEnv = {
  /** the document's own <style> text from <head>, injected into every island's shadow root */
  docCss: '',
}

/** all <style> contents of an HTML shell (doctype + head) */
export function extractCss(head: string): string {
  return Array.from(head.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi))
    .map((m) => m[1])
    .join('\n')
}
