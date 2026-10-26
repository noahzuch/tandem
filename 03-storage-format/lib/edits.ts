// The 4 typical agent edits, written the way an agent writes them: as HTML, mimicking the style of the
// surrounding (canonical, prettier-formatted) file. Each edit is a plain string replacement on the
// canonical HTML. For the other formats the "after" file is derived from the same document, and the
// minimal Edit-tool call (old_string/new_string) is computed from the before/after text (see metrics.ts).

export interface AgentEdit {
  id: string
  title: string
  /** unique text in the canonical HTML */
  find: string
  replace: string
}

const SVG = `<figure class="diagram">
  <svg width="420" height="90" viewBox="0 0 420 90" role="img" aria-label="retry loop" xmlns="http://www.w3.org/2000/svg">
    <rect x="10" y="20" width="140" height="50" rx="8" fill="#e7f0ff" stroke="#4a78c2"/>
    <text x="80" y="50" text-anchor="middle" font-family="sans-serif" font-size="14">Send batch</text>
    <rect x="270" y="20" width="140" height="50" rx="8" fill="#fff7e6" stroke="#d98e04"/>
    <text x="340" y="50" text-anchor="middle" font-family="sans-serif" font-size="14">Wait 2^n s</text>
    <path d="M150 35 H270" stroke="#4a78c2" stroke-width="2" fill="none"/>
    <path d="M270 55 H150" stroke="#d98e04" stroke-width="2" fill="none" stroke-dasharray="4 3"/>
    <text x="210" y="28" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#555">5xx</text>
  </svg>
  <figcaption>Figure 2: Retry loop with exponential backoff.</figcaption>
</figure>`

export const EDITS: AgentEdit[] = [
  {
    id: 'e1-rewrite-paragraph',
    title: 'Rewrite a paragraph (intro, keeps bold/italic/code/link)',
    find: `<p>
  Field technicians lose connectivity on site. Notes taken offline must
  <strong>sync without data loss</strong> once the device is back online. This spec covers the
  <em>client-side queue</em>, the <code>/sync</code> endpoint and
  <a href="https://example.com/adr/0007" title="ADR 0007">ADR&nbsp;0007</a> on conflict handling.
</p>`,
    replace: `<p>
  Field technicians regularly work without connectivity. Notes written offline must
  <strong>sync without data loss</strong> as soon as the device reconnects. This spec covers the
  <em>client-side outbox</em>, the <code>/sync</code> endpoint, retries, and
  <a href="https://example.com/adr/0007" title="ADR 0007">ADR&nbsp;0007</a> on conflict handling.
</p>`,
  },
  {
    id: 'e2-add-list-item',
    title: 'Add a list item (Goals)',
    find: `of reconnecting for a typical day of notes.
    </p>
  </li>`,
    replace: `of reconnecting for a typical day of notes.
    </p>
  </li>
  <li><p>The outbox survives app restarts and <strong>OS updates</strong>.</p></li>`,
  },
  {
    id: 'e3-add-table-row',
    title: 'Add a table row (error codes)',
    find: `      <td><p>Stale base version</p></td>
    </tr>`,
    replace: `      <td><p>Stale base version</p></td>
    </tr>
    <tr>
      <td><p><code>429</code></p></td>
      <td><p>Rate limited</p></td>
      <td><p>Retry after <code>Retry-After</code> seconds</p></td>
    </tr>`,
  },
  {
    id: 'e4-add-section-with-diagram',
    title: 'Add a section with an SVG diagram',
    find: `<h2 id="tasks">5. Open tasks</h2>`,
    replace: `<h2 id="retry">4.1 Retry policy</h2>
<p>Failed batches are retried with exponential backoff, capped at <strong>5 minutes</strong>.</p>
${SVG}
<h2 id="tasks">5. Open tasks</h2>`,
  },
  {
    // extra (not in the brief): a small wording change that also changes inline formatting, where
    // ProseMirror JSON must split text nodes and spell out mark objects
    id: 'e5-add-bold-and-link',
    title: 'Extra: add a bold word and a link inside a sentence',
    find: `<p>Saves are appended to the outbox and replayed <u>in order</u> on reconnect.</p>`,
    replace: `<p>
      Saves are appended to the <strong>durable</strong> outbox and replayed <u>in order</u> on
      reconnect (see <a href="#api">API</a>).
    </p>`,
  },
]

export function applyEdit(html: string, e: AgentEdit): string {
  const i = html.indexOf(e.find)
  if (i < 0 || html.indexOf(e.find, i + 1) >= 0) throw new Error(`edit ${e.id}: find text not unique/present`)
  return html.slice(0, i) + e.replace + html.slice(i + e.find.length)
}
