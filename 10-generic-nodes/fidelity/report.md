# Fidelity: generic nodes vs islands (headless pipeline, what the server writes)

| sample | preset | unknown elements | islands | generic | byte-exact | normalised only | changed | `<p>` added | attrs kept | words | stable after | prettier fixed point | bytes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| edge-inline.html | islands | 1 | 1 | 0 | 1 | 0 | 0 | 0 | 28/30 | 119/120 | 1 | yes | 1484 |
| edge-inline.html | rules | 1 | 1 | 0 | 1 | 0 | 0 | 0 | 28/30 | 119/120 | 1 | yes | 1484 |
| edge-inline.html | free | 1 | 1 | 0 | 1 | 0 | 0 | 0 | 28/30 | 119/120 | 1 | yes | 1484 |
| edge-inline.html | free+block | 1 | 1 | 0 | 1 | 0 | 0 | 0 | 28/30 | 119/120 | 1 | yes | 1484 |
| edge-inline.html | locked | 1 | 1 | 0 | 1 | 0 | 0 | 0 | 28/30 | 119/120 | 1 | yes | 1484 |
| edge-structure.html | islands | 9 | 9 | 0 | 9 | 0 | 0 | **2** | 28/28 | 129/129 | 1 | yes | 2645 |
| edge-structure.html | rules | 9 | 7 | 5 | 8 | 0 | 1 | **2** | 28/28 | 129/129 | 1 | yes | 2652 |
| edge-structure.html | free | 9 | 7 | 6 | 8 | 0 | 1 | **1** | 28/28 | 129/129 | 1 | yes | 2645 |
| edge-structure.html | free+block | 9 | 7 | 5 | 7 | 0 | 2 | **5** | 28/28 | 129/129 | 1 | yes | 2673 |
| edge-structure.html | locked | 9 | 7 | 6 | 8 | 0 | 1 | **1** | 28/28 | 129/129 | 1 | yes | 2645 |
| spec.html | islands | 2 | 2 | 0 | 2 | 0 | 0 | **1** | 95/95 | 367/367 | 1 | yes | 6290 |
| spec.html | rules | 2 | 1 | 3 | 1 | 1 | 0 | **1** | 95/95 | 367/367 | 1 | yes | 6277 |
| spec.html | free | 2 | 1 | 4 | 1 | 1 | 0 | **1** | 95/95 | 367/367 | 1 | yes | 6277 |
| spec.html | free+block | 2 | 1 | 3 | 0 | 0 | 2 | **3** | 95/95 | 367/367 | 1 | yes | 6291 |
| spec.html | locked | 2 | 1 | 4 | 1 | 1 | 0 | **1** | 95/95 | 367/367 | 1 | yes | 6277 |
| battle.html | islands | 5 | 5 | 0 | 5 | 0 | 0 | **11** | 91/91 | 265/265 | 1 | yes | 4859 |
| battle.html | rules | 5 | 2 | 13 | 2 | 3 | 0 | **7** | 91/91 | 265/265 | 1 | yes | 4768 |
| battle.html | free | 5 | 2 | 27 | 2 | 3 | 0 | **1** | 91/91 | 265/265 | 1 | yes | 4712 |
| battle.html | free+block | 5 | 2 | 12 | 1 | 0 | 4 | **17** | 91/91 | 265/265 | 1 | yes | 4866 |
| battle.html | locked | 5 | 2 | 27 | 2 | 3 | 0 | **1** | 91/91 | 265/265 | 1 | yes | 4712 |

"normalised only" = same after collapsing whitespace (indentation inside the element lost; attribute order/quoting kept). "`<p>` added" = block-level elements (whole body, known wrappers such as `<div>` included; list items / table cells excluded, Tiptap always wraps those) whose direct text got a `<p>` around it in the round trip — the fidelity cost of block+ content models; the elements are listed below.

## What changed per element

### edge-inline.html · islands

- attributes lost/changed: `mark@style=background-color: rgb(255, 192, 120)`, `a@href=javascript:alert(1)`

### edge-inline.html · rules

- attributes lost/changed: `mark@style=background-color: rgb(255, 192, 120)`, `a@href=javascript:alert(1)`

### edge-inline.html · free

- attributes lost/changed: `mark@style=background-color: rgb(255, 192, 120)`, `a@href=javascript:alert(1)`

### edge-inline.html · free+block

- attributes lost/changed: `mark@style=background-color: rgb(255, 192, 120)`, `a@href=javascript:alert(1)`

### edge-inline.html · locked

- attributes lost/changed: `mark@style=background-color: rgb(255, 192, 120)`, `a@href=javascript:alert(1)`

### edge-structure.html · islands

- text wrapped in `<p>`: `<div>`, `<blockquote>`

### edge-structure.html · rules

- &lt;figure&gt; restructured: &lt;figure&gt;&lt;img src="https://example.com/a.png" alt="figure img"&gt;&lt;figcaption&gt;Caption text&lt;/fi → &lt;figure&gt;&lt;p&gt;&lt;img src="https://example.com/a.png" alt="figure img"&gt;&lt;/p&gt;&lt;figcaption&gt;Caption text&lt;/figcaption&gt;&lt;/fi
- text wrapped in `<p>`: `<div>`, `<blockquote>`

### edge-structure.html · free

- &lt;figure&gt; restructured: &lt;figure&gt;&lt;img src="https://example.com/a.png" alt="figure img"&gt;&lt;figcaption&gt;Caption text&lt;/fi → &lt;figure&gt;&lt;p&gt;&lt;img src="https://example.com/a.png" alt="figure img"&gt;&lt;/p&gt;&lt;figcaption&gt;Caption text&lt;/figcaption&gt;&lt;/fi
- text wrapped in `<p>`: `<blockquote>`

### edge-structure.html · free+block

- &lt;dl&gt; restructured: &lt;dl&gt;&lt;dt&gt;Term&lt;/dt&gt;&lt;dd&gt;Definition&lt;/dd&gt;&lt;/dl&gt; → &lt;dl&gt;&lt;dt&gt;&lt;p&gt;Term&lt;/p&gt;&lt;/dt&gt;&lt;dd&gt;&lt;p&gt;Definition&lt;/p&gt;&lt;/dd&gt;&lt;/dl&gt;
- &lt;figure&gt; restructured: &lt;figure&gt;&lt;img src="https://example.com/a.png" alt="figure img"&gt;&lt;figcaption&gt;Caption text&lt;/fi → &lt;figure&gt;&lt;p&gt;&lt;img src="https://example.com/a.png" alt="figure img"&gt;&lt;/p&gt;&lt;figcaption&gt;&lt;p&gt;Caption text&lt;/p&gt;&lt;/figcapti
- text wrapped in `<p>`: `<div>`, `<dt>`, `<dd>`, `<blockquote>`, `<figcaption>`

### edge-structure.html · locked

- &lt;figure&gt; restructured: &lt;figure&gt;&lt;img src="https://example.com/a.png" alt="figure img"&gt;&lt;figcaption&gt;Caption text&lt;/fi → &lt;figure&gt;&lt;p&gt;&lt;img src="https://example.com/a.png" alt="figure img"&gt;&lt;/p&gt;&lt;figcaption&gt;Caption text&lt;/figcaption&gt;&lt;/fi
- text wrapped in `<p>`: `<blockquote>`

### spec.html · islands

- text wrapped in `<p>`: `<div#decision-needed>`

### spec.html · rules

- text wrapped in `<p>`: `<div#decision-needed>`

### spec.html · free

- text wrapped in `<p>`: `<div#decision-needed>`

### spec.html · free+block

- &lt;figure&gt; changed: …&lt;/text&gt;&lt;/svg&gt;&lt;figcaption&gt;Figure 1: Notes flow from the editor int… → …&lt;/text&gt;&lt;/svg&gt;&lt;figcaption&gt;&lt;p&gt;Figure 1: Notes flow from the editor …
- &lt;x-agent-note&gt; changed: …s="2026-10-24T10:15:00Z"&gt;Agent: I assumed SQLite on the device; p… → …s="2026-10-24T10:15:00Z"&gt;&lt;p&gt;Agent: I assumed SQLite on the device…
- text wrapped in `<p>`: `<div#decision-needed>`, `<figcaption>`, `<x-agent-note>`

### spec.html · locked

- text wrapped in `<p>`: `<div#decision-needed>`

### battle.html · islands

- text wrapped in `<p>`: `<div.node>`, `<div.node>`, `<div.node>`, `<div.caption>`, `<div.tall>`, `<div.b>`, `<div.a>`, `<div.far>`, `<div.ghost>`, `<div.tilt>`, `<div#decision-needed>`

### battle.html · rules

- text wrapped in `<p>`: `<div.tall>`, `<div.b>`, `<div.a>`, `<div.far>`, `<div.ghost>`, `<div.tilt>`, `<div#decision-needed>`

### battle.html · free

- text wrapped in `<p>`: `<div#decision-needed>`

### battle.html · free+block

- &lt;x-card&gt; changed: …card data-v="1"&gt;&lt;x-title&gt;Card title&lt;/x-title&gt;&lt;x-note&gt;Card body wi… → …card data-v="1"&gt;&lt;x-title&gt;&lt;p&gt;Card title&lt;/p&gt;&lt;/x-title&gt;&lt;x-note&gt;&lt;p&gt;Ca…
- &lt;dl&gt; restructured: &lt;dl class="terms"&gt;&lt;dt&gt;LWW&lt;/dt&gt;&lt;dd&gt;Last writer wins.&lt;/dd&gt;&lt;dt&gt;CRDT&lt;/dt&gt;&lt;dd&gt;Conflict-free rep → &lt;dl class="terms"&gt;&lt;dt&gt;&lt;p&gt;LWW&lt;/p&gt;&lt;/dt&gt;&lt;dd&gt;&lt;p&gt;Last writer wins.&lt;/p&gt;&lt;/dd&gt;&lt;dt&gt;&lt;p&gt;CRDT&lt;/p&gt;&lt;/dt&gt;&lt;dd&gt;&lt;p&gt;Conflict-free
- &lt;figure&gt; changed: …&lt;/text&gt;&lt;/svg&gt;&lt;figcaption&gt;Figure 1: Notes flow from the editor int… → …&lt;/text&gt;&lt;/svg&gt;&lt;figcaption&gt;&lt;p&gt;Figure 1: Notes flow from the editor …
- &lt;x-agent-note&gt; changed: …s="2026-10-25T10:15:00Z"&gt;Agent: this note is a generic text block… → …s="2026-10-25T10:15:00Z"&gt;&lt;p&gt;Agent: this note is a generic text bl…
- text wrapped in `<p>`: `<div.node>`, `<div.node>`, `<div.node>`, `<div.caption>`, `<dt>`, `<dd>`, `<dt>`, `<dd>`, `<figcaption>`, `<div.tall>`, `<div.b>`, `<div.a>`, `<div.far>`, `<div.ghost>`, `<div.tilt>`, `<div#decision-needed>`, `<x-agent-note>`

### battle.html · locked

- text wrapped in `<p>`: `<div#decision-needed>`

