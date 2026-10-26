| interaction | paragraph | container | free | locked | island | svgText |
|---|---|---|---|---|---|---|
| typing in the middle | ok | ok | ok | ok | ok | ok |
| Backspace at start | ok | ok | ok | **guarded** | **guarded** | **broken** |
| Backspace in the middle | ok | ok | ok | ok | ok | ok |
| Backspace at end | ok | ok | ok | ok | ok | **broken** |
| Delete at start | ok | ok | ok | ok | ok | ok |
| Delete in the middle | ok | ok | ok | ok | ok | ok |
| Delete at end | ok | **broken** | **broken** | **guarded** | **guarded** | **broken** |
| selection from "Before" into the target, Backspace | ok | ok | ok | **guarded** | **guarded** | ok |
| Enter in the middle | ok | ok | ok | **guarded** | **guarded** | **broken** |
| Shift+Enter in the middle | ok | ok | ok | ok | **guarded** | **broken** |
| Tab | **broken** | **broken** | **broken** | **broken** | **broken** | **broken** |
| select all, then type | ok | ok | ok | **guarded** | **guarded** | ok |
| select all, then Backspace | ok | ok | ok | **guarded** | **guarded** | ok |
| double-click a word | ok | ok | ok | ok | ok | ok |
| triple-click | ok | ok | ok | ok | ok | ok |
| → from the end of "Before" into the target | ok | ok | ok | ok | **broken** | ok |
| → from the end of the target | ok | ok | ok | ok | **broken** | **broken** |
| ↓ from inside the target | ok | ok | ok | ok | ok | ok |
| cut "beta ", paste it at the end (within) | ok | ok | ok | ok | ok | **broken** |
| copy "beta", paste at the end of "After" | ok | ok | ok | ok | ok | **broken** |
| triple-click the target, copy, paste at the end of "After" | ok | ok | ok | ok | ok | **broken** |
| double-click "Before", copy, paste in the middle of the target | ok | ok | ok | ok | ok | ok |
| paste external HTML (p + list) in the middle (synthetic paste event) | ok | ok | ok | **guarded** | n/a | ok |
| drag handle: drag the block below "After" | ok | ok | ok | ok | ok | ok |
| drag selected "beta" onto the end of "After" | n/a | n/a | n/a | n/a | n/a | n/a |
| type "one two", pause, type "X", undo ×2, redo ×2 | ok | ok | ok | ok | **broken** | **broken** |
| IME composition (CDP): compose にほ, commit 日本 | ok | ok | ok | ok | ok | ok |
| slash menu: /h2 (turn into heading 2) | ok | ok | ok | **guarded** | **guarded** | **broken** |
| slash menu: /bullet (toggle bullet list) | ok | ok | ok | **guarded** | **guarded** | **broken** |
| slash menu: /table (insert 3×3 table) | ok | ok | ok | **guarded** | **guarded** | **broken** |
| slash menu: /callout | ok | ok | ok | **guarded** | **guarded** | **broken** |
| select "beta", ⌘B | ok | ok | ok | ok | **guarded** | **broken** |
| select "beta", ⌘U (not in the locked mark list) | ok | ok | ok | **guarded** | **guarded** | **broken** |
| select "beta": does the text bubble menu appear? | ok | ok | ok | ok | **broken** | ok |
| hover: which block does the drag handle grip select? | ok | ok | ok | ok | ok | ok |
| select the target text (triple-click), Backspace: does an empty element remain, clickable, saved? | ok | ok | ok | ok | ok | **broken** |
| delete widget: hover → boxes drawn → click deletes the whole node | n/a | n/a | ok | ok | ok | n/a |
| two clients type in the same node at once (A at start, B at end) | ok | ok | ok | ok | **broken** | **broken** |
| agent replace-text / set-island-text while the user types at the start | ok | ok | ok | ok | **guarded** | ok |

## Observations

### type: typing in the middle

- **paragraph** — ok: `target="Alpha Xbeta gamma" doc="Before|Alpha Xbeta gamma|After" tree=p,p,p`
- **container** — ok: `target="Alpha Xbeta gamma" doc="Before|Left|Alpha Xbeta gamma|Right|Other|After" tree=p,div(div(h3,p),div(h3,p)),p`
- **free** — ok: `target="Alpha Xbeta gamma" doc="Before|Card|Alpha Xbeta gamma|After" tree=p,x-card(x-title,x-note),p`
- **locked** — ok: `target="Alpha Xbeta gamma" doc="Before|Card|Alpha Xbeta gamma|After" tree=p,x-card(x-title,x-note),p`
- **island** — ok: `target="Alpha Xbeta gamma" doc="Before|□|After" tree=p,island,p`
- **svgText** — ok: `target="Alpha Xbeta gamma" doc="Before|Alpha Xbeta gamma|After" tree=p,svg(rect,text),p`

### bs-start: Backspace at start

- **paragraph** — ok: `target=null doc="BeforeAlpha beta gamma|After" tree=p,p`
- **container** — ok: `target=null doc="Before|LeftAlpha beta gamma|Right|Other|After" tree=p,div(div(h3),div(h3,p)),p`
- **free** — ok: `target=null doc="Before|CardAlpha beta gamma|After" tree=p,x-card(x-title),p`
- **locked** — guarded: `target="Alpha beta gamma" doc="Before|Card|Alpha beta gamma|After" tree=p,x-card(x-title,x-note),p`
- **island** — guarded: `target="Alpha beta gamma" doc="Before|□|After" tree=p,island,p`
- **svgText** — broken: `target="Alpha beta gamma" doc="Before|Alpha beta gamma|After" tree=p,svg(rect(text)),p`

### bs-mid: Backspace in the middle

- **paragraph** — ok: `target="Alphabeta gamma" doc="Before|Alphabeta gamma|After" tree=p,p,p`
- **container** — ok: `target="Alphabeta gamma" doc="Before|Left|Alphabeta gamma|Right|Other|After" tree=p,div(div(h3,p),div(h3,p)),p`
- **free** — ok: `target="Alphabeta gamma" doc="Before|Card|Alphabeta gamma|After" tree=p,x-card(x-title,x-note),p`
- **locked** — ok: `target="Alphabeta gamma" doc="Before|Card|Alphabeta gamma|After" tree=p,x-card(x-title,x-note),p`
- **island** — ok: `target="Alphabeta gamma" doc="Before|□|After" tree=p,island,p`
- **svgText** — ok: `target="Alphabeta gamma" doc="Before|Alphabeta gamma|After" tree=p,svg(rect,text),p`

### bs-end: Backspace at end

- **paragraph** — ok: `target="Alpha beta gamm" doc="Before|Alpha beta gamm|After" tree=p,p,p`
- **container** — ok: `target="Alpha beta gamm" doc="Before|Left|Alpha beta gamm|Right|Other|After" tree=p,div(div(h3,p),div(h3,p)),p`
- **free** — ok: `target="Alpha beta gamm" doc="Before|Card|Alpha beta gamm|After" tree=p,x-card(x-title,x-note),p`
- **locked** — ok: `target="Alpha beta gamm" doc="Before|Card|Alpha beta gamm|After" tree=p,x-card(x-title,x-note),p`
- **island** — ok: `target="Alpha beta gamm" doc="Before|□|After" tree=p,island,p`
- **svgText** — broken: `target="Alpa beta gamma" doc="Before|Alpa beta gamma|After" tree=p,svg(rect,text),p`

### del-start: Delete at start

- **paragraph** — ok: `target="lpha beta gamma" doc="Before|lpha beta gamma|After" tree=p,p,p`
- **container** — ok: `target="lpha beta gamma" doc="Before|Left|lpha beta gamma|Right|Other|After" tree=p,div(div(h3,p),div(h3,p)),p`
- **free** — ok: `target="lpha beta gamma" doc="Before|Card|lpha beta gamma|After" tree=p,x-card(x-title,x-note),p`
- **locked** — ok: `target="lpha beta gamma" doc="Before|Card|lpha beta gamma|After" tree=p,x-card(x-title,x-note),p`
- **island** — ok: `target="lpha beta gamma" doc="Before|□|After" tree=p,island,p`
- **svgText** — ok: `target="lpha beta gamma" doc="Before|lpha beta gamma|After" tree=p,svg(rect,text),p`

### del-mid: Delete in the middle

- **paragraph** — ok: `target="Alpha eta gamma" doc="Before|Alpha eta gamma|After" tree=p,p,p`
- **container** — ok: `target="Alpha eta gamma" doc="Before|Left|Alpha eta gamma|Right|Other|After" tree=p,div(div(h3,p),div(h3,p)),p`
- **free** — ok: `target="Alpha eta gamma" doc="Before|Card|Alpha eta gamma|After" tree=p,x-card(x-title,x-note),p`
- **locked** — ok: `target="Alpha eta gamma" doc="Before|Card|Alpha eta gamma|After" tree=p,x-card(x-title,x-note),p`
- **island** — ok: `target="Alpha eta gamma" doc="Before|□|After" tree=p,island,p`
- **svgText** — ok: `target="Alpha eta gamma" doc="Before|Alpha eta gamma|After" tree=p,svg(rect,text),p`

### del-end: Delete at end

- **paragraph** — ok: `target="Alpha beta gammaAfter" doc="Before|Alpha beta gammaAfter" tree=p,p`
- **container** — broken: `target="Alpha beta gamma" doc="Before|Left|Alpha beta gamma|Right|Other|After" tree=p,div(div(h3,p,h3,p)),p`
- **free** — broken: `target="Alpha beta gamma" doc="Before|Card|Alpha beta gamma|After|" tree=p,x-card(x-title,x-note,p),p`
- **locked** — guarded: `target="Alpha beta gamma" doc="Before|Card|Alpha beta gamma|After" tree=p,x-card(x-title,x-note),p`
- **island** — guarded: `target="Alpha beta gamma" doc="Before|□|After" tree=p,island,p`
- **svgText** — broken: `target="Alph beta gamma" doc="Before|Alph beta gamma|After" tree=p,svg(rect,text),p`

### cross-del: selection from "Before" into the target, Backspace

- **paragraph** — ok: `target=null doc="Befbeta gamma|After" tree=p,p`
- **container** — ok: `target=null doc="Befbeta gamma|Right|Other|After" tree=p,div(div(h3,p)),p`
- **free** — ok: `target=null doc="Befbeta gamma|After" tree=p,p`
- **locked** — guarded: `target="Alpha beta gamma" doc="Before|Card|Alpha beta gamma|After" tree=p,x-card(x-title,x-note),p guard="locked node removed: x-card{\"data-edit\":\"locked\"}(x-title{}("`
- **island** — guarded: `target="Alpha beta gamma" doc="Bef|□|After" tree=p,island,p`
- **svgText** — ok: `target=null doc="Befbeta gamma|After" tree=p,p`

### enter: Enter in the middle

- **paragraph** — ok: `target="Alpha " doc="Before|Alpha |beta gamma|After" tree=p,p,p,p`
- **container** — ok: `target="Alpha " doc="Before|Left|Alpha |beta gamma|Right|Other|After" tree=p,div(div(h3,p,p),div(h3,p)),p`
- **free** — ok: `target="Alpha " doc="Before|Card|Alpha |beta gamma|After" tree=p,x-card(x-title,x-note,x-note),p`
- **locked** — guarded: `target="Alpha beta gamma" doc="Before|Card|Alpha beta gamma|After" tree=p,x-card(x-title,x-note),p`
- **island** — guarded: `target="Alpha beta gamma" doc="Before|□|After" tree=p,island,p`
- **svgText** — broken: `target="Alpha " doc="Before|Alpha |beta gamma|After" tree=p,svg(rect,text,text),p`

### shift-enter: Shift+Enter in the middle

- **paragraph** — ok: `target="Alpha beta gamma" doc="Before|Alpha □beta gamma|After" tree=p,p(br),p br=in-target`
- **container** — ok: `target="Alpha beta gamma" doc="Before|Left|Alpha □beta gamma|Right|Other|After" tree=p,div(div(h3,p(br)),div(h3,p)),p br=in-target`
- **free** — ok: `target="Alpha beta gamma" doc="Before|Card|Alpha □beta gamma|After" tree=p,x-card(x-title,x-note(br)),p br=in-target`
- **locked** — ok: `target="Alpha beta gamma" doc="Before|Card|Alpha □beta gamma|After" tree=p,x-card(x-title,x-note(br)),p br=in-target`
- **island** — guarded: `target="Alpha beta gamma" doc="Before|□|After" tree=p,island,p br=elsewhere`
- **svgText** — broken: `target="Alpha " doc="Before|Alpha |□beta gamma|After" tree=p,svg(rect,text),p(br),p br=elsewhere`

### tab: Tab

- **paragraph** — broken: `target="Alpha beta gamma" doc="Before|Alpha beta gamma|After" tree=p,p,p focus=body`
- **container** — broken: `target="Alpha beta gamma" doc="Before|Left|Alpha beta gamma|Right|Other|After" tree=p,div(div(h3,p),div(h3,p)),p focus=body`
- **free** — broken: `target="Alpha beta gamma" doc="Before|Card|Alpha beta gamma|After" tree=p,x-card(x-title,x-note),p focus=button`
- **locked** — broken: `target="Alpha beta gamma" doc="Before|Card|Alpha beta gamma|After" tree=p,x-card(x-title,x-note),p focus=button`
- **island** — broken: `target="Alpha beta gamma" doc="Before|□|After" tree=p,island,p focus=button`
- **svgText** — broken: `target="Alpha beta gamma" doc="Before|Alpha beta gamma|After" tree=p,svg(rect,text),p focus=body`

### select-all-type: select all, then type

- **paragraph** — ok: `target=null doc="Z" tree=p`
- **container** — ok: `target=null doc="Z" tree=p`
- **free** — ok: `target=null doc="Z" tree=p`
- **locked** — guarded: `target="Alpha beta gamma" doc="Before|Card|Alpha beta gamma|After" tree=p,x-card(x-title,x-note),p guard="locked node removed: x-card{\"data-edit\":\"locked\"}(x-title{}("`
- **island** — guarded: `target="Z" doc="Before|□|After" tree=p,island,p`
- **svgText** — ok: `target=null doc="Z" tree=p`

### select-all-del: select all, then Backspace

- **paragraph** — ok: `target=null doc="" tree=p`
- **container** — ok: `target=null doc="" tree=p`
- **free** — ok: `target=null doc="" tree=p`
- **locked** — guarded: `target="Alpha beta gamma" doc="Before|Card|Alpha beta gamma|After" tree=p,x-card(x-title,x-note),p guard="locked node removed: x-card{\"data-edit\":\"locked\"}(x-title{}("`
- **island** — guarded: `target="" doc="Before|□|After" tree=p,island,p`
- **svgText** — ok: `target=null doc="" tree=p`

### dblclick: double-click a word

- **paragraph** — ok: `target="Alpha beta gamma" doc="Before|Alpha beta gamma|After" tree=p,p,p selected="beta"`
- **container** — ok: `target="Alpha beta gamma" doc="Before|Left|Alpha beta gamma|Right|Other|After" tree=p,div(div(h3,p),div(h3,p)),p selected="beta"`
- **free** — ok: `target="Alpha beta gamma" doc="Before|Card|Alpha beta gamma|After" tree=p,x-card(x-title,x-note),p selected="beta"`
- **locked** — ok: `target="Alpha beta gamma" doc="Before|Card|Alpha beta gamma|After" tree=p,x-card(x-title,x-note),p selected="beta"`
- **island** — ok: `target="Alpha beta gamma" doc="Before|□|After" tree=p,island,p selected="beta"`
- **svgText** — ok: `target="Alpha beta gamma" doc="Before|Alpha beta gamma|After" tree=p,svg(rect,text),p selected="beta"`

### tripleclick: triple-click

- **paragraph** — ok: `target="Alpha beta gamma" doc="Before|Alpha beta gamma|After" tree=p,p,p selected="Alpha beta gamma"`
- **container** — ok: `target="Alpha beta gamma" doc="Before|Left|Alpha beta gamma|Right|Other|After" tree=p,div(div(h3,p),div(h3,p)),p selected="Alpha beta gamma"`
- **free** — ok: `target="Alpha beta gamma" doc="Before|Card|Alpha beta gamma|After" tree=p,x-card(x-title,x-note),p selected="Alpha beta gamma"`
- **locked** — ok: `target="Alpha beta gamma" doc="Before|Card|Alpha beta gamma|After" tree=p,x-card(x-title,x-note),p selected="Alpha beta gamma"`
- **island** — ok: `target="Alpha beta gamma" doc="Before|□|After" tree=p,island,p selected="Alpha beta gamma"`
- **svgText** — ok: `target="Alpha beta gamma" doc="Before|Alpha beta gamma|After" tree=p,svg(rect,text),p selected="Alpha beta gamma"`

### arrow-in: → from the end of "Before" into the target

- **paragraph** — ok: `target="Alpha beta gamma" doc="Before|Alpha beta gamma|After" tree=p,p,p caret=p@0 "Alpha beta g"`
- **container** — ok: `target="Alpha beta gamma" doc="Before|Left|Alpha beta gamma|Right|Other|After" tree=p,div(div(h3,p),div(h3,p)),p caret=h3@0 "Left"`
- **free** — ok: `target="Alpha beta gamma" doc="Before|Card|Alpha beta gamma|After" tree=p,x-card(x-title,x-note),p caret=x-title@0 "Card"`
- **locked** — ok: `target="Alpha beta gamma" doc="Before|Card|Alpha beta gamma|After" tree=p,x-card(x-title,x-note),p caret=x-title@0 "Card"`
- **island** — broken: `target="Alpha beta gamma" doc="Before|□|After" tree=p,island,p caret=node:island`
- **svgText** — ok: `target="Alpha beta gamma" doc="Before|Alpha beta gamma|After" tree=p,svg(rect,text),p caret=text@0 "Alpha beta g"`

### arrow-out: → from the end of the target

- **paragraph** — ok: `target="Alpha beta gamma" doc="Before|Alpha beta gamma|After" tree=p,p,p caret=p@0 "After"`
- **container** — ok: `target="Alpha beta gamma" doc="Before|Left|Alpha beta gamma|Right|Other|After" tree=p,div(div(h3,p),div(h3,p)),p caret=h3@0 "Right"`
- **free** — ok: `target="Alpha beta gamma" doc="Before|Card|Alpha beta gamma|After" tree=p,x-card(x-title,x-note),p caret=p@0 "After"`
- **locked** — ok: `target="Alpha beta gamma" doc="Before|Card|Alpha beta gamma|After" tree=p,x-card(x-title,x-note),p caret=p@0 "After"`
- **island** — broken: `target="Alpha beta gamma" doc="Before|□|After" tree=p,island,p caret=p@5 "After"`
- **svgText** — broken: `target="Alpha beta gamma" doc="Before|Alpha beta gamma|After" tree=p,svg(rect,text),p caret=text@5 "Alpha beta g"`

### arrow-down-out: ↓ from inside the target

- **paragraph** — ok: `target="Alpha beta gamma" doc="Before|Alpha beta gamma|After" tree=p,p,p caret=p@5 "After"`
- **container** — ok: `target="Alpha beta gamma" doc="Before|Left|Alpha beta gamma|Right|Other|After" tree=p,div(div(h3,p),div(h3,p)),p caret=h3@0 "Right"`
- **free** — ok: `target="Alpha beta gamma" doc="Before|Card|Alpha beta gamma|After" tree=p,x-card(x-title,x-note),p caret=p@5 "After"`
- **locked** — ok: `target="Alpha beta gamma" doc="Before|Card|Alpha beta gamma|After" tree=p,x-card(x-title,x-note),p caret=p@5 "After"`
- **island** — ok: `target="Alpha beta gamma" doc="Before|□|After" tree=p,island,p caret=p@5 "After"`
- **svgText** — ok: `target="Alpha beta gamma" doc="Before|Alpha beta gamma|After" tree=p,svg(rect,text),p caret=p@5 "After"`

### cut-paste: cut "beta ", paste it at the end (within)

- **paragraph** — ok: `target="Alpha gammabeta " doc="Before|Alpha gammabeta |After" tree=p,p,p`
- **container** — ok: `target="Alpha gammabeta " doc="Before|Left|Alpha gammabeta |Right|Other|After" tree=p,div(div(h3,p),div(h3,p)),p`
- **free** — ok: `target="Alpha gammabeta " doc="Before|Card|Alpha gammabeta |After" tree=p,x-card(x-title,x-note),p`
- **locked** — ok: `target="Alpha gammabeta " doc="Before|Card|Alpha gammabeta |After" tree=p,x-card(x-title,x-note),p`
- **island** — ok: `target="Alpha gammabeta " doc="Before|□|After" tree=p,island,p`
- **svgText** — broken: `target="Alpha gamma" doc="Before|Alpha gamma|□|After" tree=p,svg(rect,text),island,p`

### copy-out: copy "beta", paste at the end of "After"

- **paragraph** — ok: `target="Alpha beta gamma" doc="Before|Alpha beta gamma|Afterbeta" tree=p,p,p`
- **container** — ok: `target="Alpha beta gamma" doc="Before|Left|Alpha beta gamma|Right|Other|Afterbeta" tree=p,div(div(h3,p),div(h3,p)),p`
- **free** — ok: `target="Alpha beta gamma" doc="Before|Card|Alpha beta gamma|Afterbeta" tree=p,x-card(x-title,x-note),p`
- **locked** — ok: `target="Alpha beta gamma" doc="Before|Card|Alpha beta gamma|Afterbeta" tree=p,x-card(x-title,x-note),p`
- **island** — ok: `target="Alpha beta gamma" doc="Before|□|Afterbeta" tree=p,island,p`
- **svgText** — broken: `target="Alpha beta gamma" doc="Before|Alpha beta gamma|After|□|" tree=p,svg(rect,text),p,island,p`

### copy-block-out: triple-click the target, copy, paste at the end of "After"

- **paragraph** — ok: `target="Alpha beta gamma" doc="Before|Alpha beta gamma|AfterAlpha beta gamma" tree=p,p,p`
- **container** — ok: `target="Alpha beta gamma" doc="Before|Left|Alpha beta gamma|Right|Other|AfterAlpha beta gamma" tree=p,div(div(h3,p),div(h3,p)),p`
- **free** — ok: `target="Alpha beta gamma" doc="Before|Card|Alpha beta gamma|AfterAlpha beta gamma" tree=p,x-card(x-title,x-note),p`
- **locked** — ok: `target="Alpha beta gamma" doc="Before|Card|Alpha beta gamma|AfterAlpha beta gamma" tree=p,x-card(x-title,x-note),p`
- **island** — ok: `target="Alpha beta gamma" doc="Before|□|AfterAlpha beta gamma" tree=p,island,p`
- **svgText** — broken: `target="Alpha beta gamma" doc="Before|Alpha beta gamma|After|□|" tree=p,svg(rect,text),p,island,p`

### paste-text: double-click "Before", copy, paste in the middle of the target

- **paragraph** — ok: `target="Alpha Beforebeta gamma" doc="Before|Alpha Beforebeta gamma|After" tree=p,p,p`
- **container** — ok: `target="Alpha Beforebeta gamma" doc="Before|Left|Alpha Beforebeta gamma|Right|Other|After" tree=p,div(div(h3,p),div(h3,p)),p`
- **free** — ok: `target="Alpha Beforebeta gamma" doc="Before|Card|Alpha Beforebeta gamma|After" tree=p,x-card(x-title,x-note),p`
- **locked** — ok: `target="Alpha Beforebeta gamma" doc="Before|Card|Alpha Beforebeta gamma|After" tree=p,x-card(x-title,x-note),p`
- **island** — ok: `target="Alpha Beforebeta gamma" doc="Before|□|After" tree=p,island,p`
- **svgText** — ok: `target="Alpha Beforebeta gamma" doc="Before|Alpha Beforebeta gamma|After" tree=p,svg(rect,text),p`

### paste-html: paste external HTML (p + list) in the middle (synthetic paste event)

- **paragraph** — ok: `target="Alpha Ext bold" doc="Before|Alpha Ext bold|item onebeta gamma|After" tree=p,p,ul(li(p)),p into=DIV`
- **container** — ok: `target="Alpha Ext bold" doc="Before|Left|Alpha Ext bold|item onebeta gamma|Right|Other|After" tree=p,div(div(h3,p,ul(li(p))),div(h3,p)),p into=DIV`
- **free** — ok: `target="Alpha Ext bold" doc="Before|Card|Alpha Ext bold|item onebeta gamma|After" tree=p,x-card(x-title,x-note,ul(li(p))),p into=DIV`
- **locked** — guarded: `target="Alpha beta gamma" doc="Before|Card|Alpha beta gamma|After" tree=p,x-card(x-title,x-note),p into=DIV guard="locked node structure changed: x-card{\"data-edit\":\"locked\"}("`
- **island** — ok: `n/a: plaintext-only leaf in a shadow root: a native paste inserts plain text, a synthetic paste event cannot be aimed at it`
- **svgText** — ok: `target="Alpha Ext bold" doc="Before|Alpha Ext bold|item onebeta gamma|After" tree=p,svg(rect,text),ul(li(p)),p into=DIV`

### drag-block: drag handle: drag the block below "After"

- **paragraph** — ok: `target="Alpha beta gamma" doc="Before|After|Alpha beta gamma" tree=p,p,p handle=shown`
- **container** — ok: `target="Alpha beta gamma" doc="Before|After|Left|Alpha beta gamma|Right|Other|" tree=p,p,div(div(h3,p),div(h3,p)),p handle=shown`
- **free** — ok: `target="Alpha beta gamma" doc="Before|After|Card|Alpha beta gamma|" tree=p,p,x-card(x-title,x-note),p handle=shown`
- **locked** — ok: `target="Alpha beta gamma" doc="Before|After|Card|Alpha beta gamma|" tree=p,p,x-card(x-title,x-note),p handle=shown`
- **island** — ok: `target="Alpha beta gamma" doc="Before|After|□|" tree=p,p,island,p handle=shown`
- **svgText** — ok: `target="Alpha beta gamma" doc="Before|After|Alpha beta gamma|" tree=p,p,svg(rect,text),p handle=shown`

### drag-text: drag selected "beta" onto the end of "After"

- **paragraph** — ok: `n/a: not automatable: headless Chromium starts no native text drag (dragstart=0 on every kind)`
- **container** — ok: `n/a: not automatable: headless Chromium starts no native text drag (dragstart=0 on every kind)`
- **free** — ok: `n/a: not automatable: headless Chromium starts no native text drag (dragstart=0 on every kind)`
- **locked** — ok: `n/a: not automatable: headless Chromium starts no native text drag (dragstart=0 on every kind)`
- **island** — ok: `n/a: not automatable: headless Chromium starts no native text drag (dragstart=0 on every kind)`
- **svgText** — ok: `n/a: not automatable: headless Chromium starts no native text drag (dragstart=0 on every kind)`

### undo: type "one two", pause, type "X", undo ×2, redo ×2

- **paragraph** — ok: `target="Alpha beta gamma one twoX" doc="Before|Alpha beta gamma one twoX|After" tree=p,p,p undo1="Alpha beta gamma one two" undo2="Alpha beta gamma"`
- **container** — ok: `target="Alpha beta gamma one twoX" doc="Before|Left|Alpha beta gamma one twoX|Right|Other|After" tree=p,div(div(h3,p),div(h3,p)),p undo1="Alpha beta gamma one two" undo2="Alpha beta gamma"`
- **free** — ok: `target="Alpha beta gamma one twoX" doc="Before|Card|Alpha beta gamma one twoX|After" tree=p,x-card(x-title,x-note),p undo1="Alpha beta gamma one two" undo2="Alpha beta gamma"`
- **locked** — ok: `target="Alpha beta gamma one twoX" doc="Before|Card|Alpha beta gamma one twoX|After" tree=p,x-card(x-title,x-note),p undo1="Alpha beta gamma one two" undo2="Alpha beta gamma"`
- **island** — broken: `target="Alpha beta gamma" doc="Before|□|After" tree=p,island,p undo1="Alpha beta gamma one two" undo2="Alpha beta gamma"`
- **svgText** — broken: `target="Alph one twoXa beta gamma" doc="Before|Alph one twoXa beta gamma|After" tree=p,svg(rect,text),p undo1="Alph one twoa beta gamma" undo2="Alpha beta gamma"`

### ime: IME composition (CDP): compose にほ, commit 日本

- **paragraph** — ok: `target="Alpha 日本beta gamma" doc="Before|Alpha 日本beta gamma|After" tree=p,p,p mid="Alpha にほbeta gamma"`
- **container** — ok: `target="Alpha 日本beta gamma" doc="Before|Left|Alpha 日本beta gamma|Right|Other|After" tree=p,div(div(h3,p),div(h3,p)),p mid="Alpha にほbeta gamma"`
- **free** — ok: `target="Alpha 日本beta gamma" doc="Before|Card|Alpha 日本beta gamma|After" tree=p,x-card(x-title,x-note),p mid="Alpha にほbeta gamma"`
- **locked** — ok: `target="Alpha 日本beta gamma" doc="Before|Card|Alpha 日本beta gamma|After" tree=p,x-card(x-title,x-note),p mid="Alpha にほbeta gamma"`
- **island** — ok: `target="Alpha 日本beta gamma" doc="Before|□|After" tree=p,island,p mid="Alpha beta gamma"`
- **svgText** — ok: `target="Alpha 日本beta gamma" doc="Before|Alpha 日本beta gamma|After" tree=p,svg(rect,text),p mid="Alpha にほbeta gamma"`

### slash-h2: slash menu: /h2 (turn into heading 2)

- **paragraph** — ok: `target="Alpha beta gamma " doc="Before|Alpha beta gamma |After" tree=p,h2,p`
- **container** — ok: `target="Alpha beta gamma " doc="Before|Left|Alpha beta gamma |Right|Other|After" tree=p,div(div(h3,h2),div(h3,p)),p`
- **free** — ok: `target=null doc="Before|Card|Alpha beta gamma |After" tree=p,x-card(x-title,h2),p`
- **locked** — guarded: `target="Alpha beta gamma " doc="Before|Card|Alpha beta gamma |After" tree=p,x-card(x-title,x-note),p guard="locked node structure changed: x-card{\"data-edit\":\"locked\"}("`
- **island** — guarded: `target="Alpha beta gamma /h2" doc="Before|□|After" tree=p,island,p`
- **svgText** — broken: `target="Alph h2" doc="Before|Alph h2|/a beta gamma|After" tree=p,svg(rect,text,text),p`

### slash-list: slash menu: /bullet (toggle bullet list)

- **paragraph** — ok: `target="Alpha beta gamma " doc="Before|Alpha beta gamma |After" tree=p,ul(li(p)),p`
- **container** — ok: `target="Alpha beta gamma " doc="Before|Left|Alpha beta gamma |Right|Other|After" tree=p,div(div(h3,ul(li(p))),div(h3,p)),p`
- **free** — ok: `target=null doc="Before|Card|Alpha beta gamma |After" tree=p,x-card(x-title),ul(li(p)),p`
- **locked** — guarded: `target="Alpha beta gamma " doc="Before|Card|Alpha beta gamma |After" tree=p,x-card(x-title,x-note),p guard="locked node structure changed: x-card{\"data-edit\":\"locked\"}("`
- **island** — guarded: `target="Alpha beta gamma /bullet" doc="Before|□|After" tree=p,island,p`
- **svgText** — broken: `target="Alph bullet" doc="Before|Alph bullet|/a beta gamma|After" tree=p,svg(rect,text,text),p`

### slash-table: slash menu: /table (insert 3×3 table)

- **paragraph** — ok: `target="Alpha beta gamma " doc="Before|Alpha beta gamma ||||||||||After" tree=p,p,table(tr(th(p),th(p),th(p)),tr(td(p),td(p),td(p)),tr(td(p),td(p),td(p))),p`
- **container** — ok: `target="Alpha beta gamma " doc="Before|Left|Alpha beta gamma ||||||||||Right|Other|After" tree=p,div(div(h3,p,table(tr(th(p),th(p),th(p)),tr(td(p),td(p),td(p)),tr(td(p),td(p),td(p)))),div(h3,p)),p`
- **free** — ok: `target="Alpha beta gamma " doc="Before|Card|Alpha beta gamma ||||||||||After" tree=p,x-card(x-title,x-note,table(tr(th(p),th(p),th(p)),tr(td(p),td(p),td(p)),tr(td(p),td(p),td(p)))),p`
- **locked** — guarded: `target="Alpha beta gamma " doc="Before|Card|Alpha beta gamma |After" tree=p,x-card(x-title,x-note),p guard="locked node structure changed: x-card{\"data-edit\":\"locked\"}("`
- **island** — guarded: `target="Alpha beta gamma /table" doc="Before|□|After" tree=p,island,p`
- **svgText** — broken: `target="Alph table" doc="Before|Alph table|/a beta gamma|After" tree=p,svg(rect,text,text),p`

### slash-callout: slash menu: /callout

- **paragraph** — ok: `target="Alpha beta gamma " doc="Before|Alpha beta gamma ||After" tree=p,p,callout(p),p`
- **container** — ok: `target="Alpha beta gamma " doc="Before|Left|Alpha beta gamma ||Right|Other|After" tree=p,div(div(h3,p,callout(p)),div(h3,p)),p`
- **free** — ok: `target="Alpha beta gamma " doc="Before|Card|Alpha beta gamma ||After" tree=p,x-card(x-title,x-note,callout(p)),p`
- **locked** — guarded: `target="Alpha beta gamma " doc="Before|Card|Alpha beta gamma |After" tree=p,x-card(x-title,x-note),p guard="locked node structure changed: x-card{\"data-edit\":\"locked\"}("`
- **island** — guarded: `target="Alpha beta gamma /callout" doc="Before|□|After" tree=p,island,p`
- **svgText** — broken: `target="Alph callout" doc="Before|Alph callout|/a beta gamma|After" tree=p,svg(rect,text,text),p`

### bold: select "beta", ⌘B

- **paragraph** — ok: `target="Alpha beta gamma" doc="Before|Alpha beta gamma|After" tree=p,p,p html=bold`
- **container** — ok: `target="Alpha beta gamma" doc="Before|Left|Alpha beta gamma|Right|Other|After" tree=p,div(div(h3,p),div(h3,p)),p html=bold`
- **free** — ok: `target="Alpha beta gamma" doc="Before|Card|Alpha beta gamma|After" tree=p,x-card(x-title,x-note),p html=bold`
- **locked** — ok: `target="Alpha beta gamma" doc="Before|Card|Alpha beta gamma|After" tree=p,x-card(x-title,x-note),p html=bold`
- **island** — guarded: `target="Alpha beta gamma" doc="Before|□|After" tree=p,island,p html=plain`
- **svgText** — broken: `target="Alpha beta gamma" doc="Before|Alpha beta gamma|After" tree=p,svg(rect,text),p html=plain`

### underline: select "beta", ⌘U (not in the locked mark list)

- **paragraph** — ok: `target="Alpha beta gamma" doc="Before|Alpha beta gamma|After" tree=p,p,p html=underlined`
- **container** — ok: `target="Alpha beta gamma" doc="Before|Left|Alpha beta gamma|Right|Other|After" tree=p,div(div(h3,p),div(h3,p)),p html=underlined`
- **free** — ok: `target="Alpha beta gamma" doc="Before|Card|Alpha beta gamma|After" tree=p,x-card(x-title,x-note),p html=underlined`
- **locked** — guarded: `target="Alpha beta gamma" doc="Before|Card|Alpha beta gamma|After" tree=p,x-card(x-title,x-note),p html=plain guard="mark \"underline\" not allowed in locked <x-card> (allowed: bo"`
- **island** — guarded: `target="Alpha beta gamma" doc="Before|□|After" tree=p,island,p html=plain`
- **svgText** — broken: `target="Alpha beta gamma" doc="Before|Alpha beta gamma|After" tree=p,svg(rect,text),p html=plain`

### bubble: select "beta": does the text bubble menu appear?

- **paragraph** — ok: `target="Alpha beta gamma" doc="Before|Alpha beta gamma|After" tree=p,p,p bubble=shown`
- **container** — ok: `target="Alpha beta gamma" doc="Before|Left|Alpha beta gamma|Right|Other|After" tree=p,div(div(h3,p),div(h3,p)),p bubble=shown`
- **free** — ok: `target="Alpha beta gamma" doc="Before|Card|Alpha beta gamma|After" tree=p,x-card(x-title,x-note),p bubble=shown`
- **locked** — ok: `target="Alpha beta gamma" doc="Before|Card|Alpha beta gamma|After" tree=p,x-card(x-title,x-note),p bubble=shown`
- **island** — broken: `target="Alpha beta gamma" doc="Before|□|After" tree=p,island,p bubble=hidden`
- **svgText** — ok: `target="Alpha beta gamma" doc="Before|Alpha beta gamma|After" tree=p,svg(rect,text),p bubble=shown`

### handle: hover: which block does the drag handle grip select?

- **paragraph** — ok: `target="Alpha beta gamma" doc="Before|Alpha beta gamma|After" tree=p,p,p handle=node:p`
- **container** — ok: `target="Alpha beta gamma" doc="Before|Left|Alpha beta gamma|Right|Other|After" tree=p,div(div(h3,p),div(h3,p)),p handle=node:div`
- **free** — ok: `target="Alpha beta gamma" doc="Before|Card|Alpha beta gamma|After" tree=p,x-card(x-title,x-note),p handle=node:x-card`
- **locked** — ok: `target="Alpha beta gamma" doc="Before|Card|Alpha beta gamma|After" tree=p,x-card(x-title,x-note),p handle=node:x-card`
- **island** — ok: `target="Alpha beta gamma" doc="Before|□|After" tree=p,island,p handle=node:island`
- **svgText** — ok: `target="Alpha beta gamma" doc="Before|Alpha beta gamma|After" tree=p,svg(rect,text),p handle=node:svg`

### empty: select the target text (triple-click), Backspace: does an empty element remain, clickable, saved?

- **paragraph** — ok: `target="Re" doc="Before|Re|After" tree=p,p,p emptyHtml=present box=684x26 saved=element-kept`
- **container** — ok: `target="Re" doc="Before|Left|Re|Right|Other|After" tree=p,div(div(h3,p),div(h3,p)),p emptyHtml=present box=334x26 saved=element-kept`
- **free** — ok: `target="Re" doc="Before|Card|Re|After" tree=p,x-card(x-title,x-note),p emptyHtml=present box=654x26 saved=element-kept`
- **locked** — ok: `target="Re" doc="Before|Card|Re|After" tree=p,x-card(x-title,x-note),p emptyHtml=present box=654x26 saved=element-kept`
- **island** — ok: `target="Re" doc="Before|□|After" tree=p,island,p emptyHtml=present box=654x26 saved=element-kept`
- **svgText** — broken: `target="" doc="Before||ReAfter" tree=p,svg(rect,text),p emptyHtml=present box=0x0 saved=element-kept`

### delete-widget: delete widget: hover → boxes drawn → click deletes the whole node

- **paragraph** — ok: `n/a: no widget for schema nodes`
- **container** — ok: `n/a: no widget for schema nodes`
- **free** — ok: `target=null doc="Before|After" tree=p,p widget=shown boxes=2 badge="removes 2 elements · 3 words"`
- **locked** — ok: `target=null doc="Before|After" tree=p,p widget=shown boxes=2 badge="removes 2 elements · 3 words"`
- **island** — ok: `target=null doc="Before|After" tree=p,p widget=shown boxes=4 badge="removes 4 elements · 1 words"`
- **svgText** — ok: `n/a: widget covers generic nodes and islands`

### concurrent: two clients type in the same node at once (A at start, B at end)

- **paragraph** — ok: `A="AAAparagraph alpha beta gammaBBB" B="AAAparagraph alpha beta gammaBBB"`
- **container** — ok: `A="AAAcontainer alpha beta gammaBBB" B="AAAcontainer alpha beta gammaBBB"`
- **free** — ok: `A="AAAfree alpha beta gammaBBB" B="AAAfree alpha beta gammaBBB"`
- **locked** — ok: `A="AAAlocked alpha beta gammaBBB" B="AAAlocked alpha beta gammaBBB"`
- **island** — broken: `one side lost (last writer wins per island), both clients agree: "island alpha beta gamma" + the winner's text`
- **svgText** — broken: `A="AAAsvgTBBBext alpha beta gamma" B="AAAsvgTBBBext alpha beta gamma"`

### agent: agent replace-text / set-island-text while the user types at the start

- **paragraph** — ok: `exit=0 target="UUAAAparagraph ALPHA beta gammaBBB"`
- **container** — ok: `exit=0 target="UUAAAcontainer ALPHA beta gammaBBB"`
- **free** — ok: `exit=0 target="UUAAAfree ALPHA beta gammaBBB"`
- **locked** — ok: `exit=0 target="UUAAAlocked ALPHA beta gammaBBB"`
- **island** — guarded: `exit=5 target="UUisland alpha beta gamma + the winner's text" locked=Ann`
- **svgText** — ok: `exit=0 target="UUAAAsvgTBBBext ALPHA beta gamma"`
