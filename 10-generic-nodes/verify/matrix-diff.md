165 cells identical (verdict + observation), 30 changed: 2 fixed (broken → guarded/ok), 6 now protected (ok → guarded: the interaction used to work like in a paragraph by destroying structure), 0 worse, 21 same verdict with a different observation; 30 new (round 2 rows). svgText (the experiment) is not compared.

| interaction | paragraph | container | free | locked | island |
|---|---|---|---|---|---|
| typing in the middle | ok | ok | ok | ok | ok |
| Backspace at start | ok | ok | **ok → guarded** | guarded (differs) | guarded |
| Backspace in the middle | ok | ok | ok | ok | ok |
| Backspace at end | ok | ok | ok | ok | ok |
| Delete at start | ok | ok | ok | ok | ok |
| Delete in the middle | ok | ok | ok | ok | ok |
| Delete at end | ok | **broken → guarded** | **broken → guarded** | guarded (differs) | guarded |
| selection from "Before" into the target, Backspace | ok | **ok → guarded** | **ok → guarded** | guarded (differs) | guarded |
| selection from the target into "After", Backspace | new: ok | new: guarded | new: guarded | new: guarded | new: guarded |
| Backspace at the start of the element's first child | new: n/a | new: guarded | new: guarded | new: guarded | new: guarded |
| Delete at the end of the first child (would pull the target in) | new: n/a | new: ok | new: guarded | new: guarded | new: guarded |
| select first child → end of target (inside the element), Backspace | new: n/a | new: ok | new: ok | new: ok | new: ok |
| Enter in the middle | ok (differs) | ok (differs) | ok (differs) | guarded (differs) | guarded (differs) |
| Enter at the end, type "new" | new: ok | new: ok | new: ok | new: guarded | new: broken |
| Shift+Enter in the middle | ok | ok | ok | ok | guarded |
| Tab | broken | broken (differs) | broken | broken | broken |
| select all, then type | ok | ok | ok | guarded (differs) | guarded |
| select all, then Backspace | ok | ok | ok | guarded (differs) | guarded |
| double-click a word | ok | ok | ok | ok | ok |
| triple-click | ok | ok | ok | ok | ok |
| → from the end of "Before" into the target | ok | ok | ok | ok | broken |
| → from the end of the target | ok | ok | ok | ok | broken |
| ↓ from inside the target | ok | ok | ok | ok | ok |
| cut "beta ", paste it at the end (within) | ok | ok | ok (differs) | ok (differs) | ok |
| copy "beta", paste at the end of "After" | ok | ok | ok | ok | ok |
| triple-click the target, copy, paste at the end of "After" | ok | ok | ok | ok | ok |
| double-click "Before", copy, paste in the middle of the target | ok | ok | ok | ok | ok |
| paste external HTML (p + list) in the middle (synthetic paste event) | ok | ok | **ok → guarded** | guarded (differs) | n/a |
| drag handle: drag the block below "After" | ok | ok | ok | ok | ok |
| drag selected "beta" onto the end of "After" | n/a | n/a | n/a | n/a | n/a |
| type "one two", pause, type "X", undo ×2, redo ×2 | ok | ok | ok | ok | broken |
| IME composition (CDP): compose にほ, commit 日本 | ok | ok | ok | ok | ok |
| slash menu: /h2 (turn into heading 2) | ok | ok | **ok → guarded** | guarded (differs) | guarded |
| slash menu: /bullet (toggle bullet list) | ok | ok | **ok → guarded** | guarded (differs) | guarded |
| slash menu: /table (insert 3×3 table) | ok | ok | ok | guarded | guarded |
| slash menu: /callout | ok | ok | ok | guarded | guarded |
| select "beta", ⌘B | ok | ok | ok | ok | guarded |
| select "beta", ⌘U (not in the locked mark list) | ok | ok | ok | guarded (differs) | guarded |
| select "beta": does the text bubble menu appear? | ok | ok | ok | ok | broken |
| hover: which block does the drag handle grip select? | ok | ok | ok | ok | ok |
| select the target text (triple-click), Backspace: does an empty element remain, clickable, saved? | ok | ok | ok | ok | ok |
| delete UI: hover the element → trash → preview (overlay + summary) → click deletes the element | n/a (differs) | **n/a → ok** | ok (differs) | ok (differs) | ok (differs) |
| keyboard: block handle grip selects the block, Backspace → confirm bar → Enter deletes | new: ok | new: ok | new: ok | new: ok | new: ok |
| two clients type in the same node at once (A at start, B at end) | ok | ok | ok | ok | broken |
| agent replace-text / set-island-text while the user types at the start | ok | ok | ok | ok | guarded |

## Changed cells, observation before → after

- **bs-start / free**: ok → guarded
  - v1: `target=null doc="Before|CardAlpha beta gamma|After" tree=p,x-card(x-title),p`
  - v2: `target="Alpha beta gamma" doc="Before|Card|Alpha beta gamma|After" tree=p,x-card(x-title,x-note),p guard="protect: Backspace at the start of <x-note> does not join it"`
- **bs-start / locked**: guarded → guarded
  - v1: `target="Alpha beta gamma" doc="Before|Card|Alpha beta gamma|After" tree=p,x-card(x-title,x-note),p`
  - v2: `target="Alpha beta gamma" doc="Before|Card|Alpha beta gamma|After" tree=p,x-card(x-title,x-note),p guard="protect: Backspace at the start of <x-note> does not join it"`
- **del-end / container**: broken → guarded
  - v1: `target="Alpha beta gamma" doc="Before|Left|Alpha beta gamma|Right|Other|After" tree=p,div(div(h3,p,h3,p)),p`
  - v2: `target="Alpha beta gamma" doc="Before|Left|Alpha beta gamma|Right|Other|After" tree=p,div(div(h3,p),div(h3,p)),p guard="protect: Delete at the end of the last block inside <div> do"`
- **del-end / free**: broken → guarded
  - v1: `target="Alpha beta gamma" doc="Before|Card|Alpha beta gamma|After|" tree=p,x-card(x-title,x-note,p),p`
  - v2: `target="Alpha beta gamma" doc="Before|Card|Alpha beta gamma|After" tree=p,x-card(x-title,x-note),p guard="protect: Delete at the end of <x-note> does not join the nex"`
- **del-end / locked**: guarded → guarded
  - v1: `target="Alpha beta gamma" doc="Before|Card|Alpha beta gamma|After" tree=p,x-card(x-title,x-note),p`
  - v2: `target="Alpha beta gamma" doc="Before|Card|Alpha beta gamma|After" tree=p,x-card(x-title,x-note),p guard="protect: Delete at the end of <x-note> does not join the nex"`
- **cross-del / container**: ok → guarded
  - v1: `target=null doc="Befbeta gamma|Right|Other|After" tree=p,div(div(h3,p)),p`
  - v2: `target="Alpha beta gamma" doc="Bef|Left|Alpha beta gamma|Right|Other|After" tree=p,div(div(h3,p),div(h3,p)),p guard="protect: selection clamped to before <div> (it started outsi"`
- **cross-del / free**: ok → guarded
  - v1: `target=null doc="Befbeta gamma|After" tree=p,p`
  - v2: `target="Alpha beta gamma" doc="Bef|Card|Alpha beta gamma|After" tree=p,x-card(x-title,x-note),p guard="protect: selection clamped to before <x-card> (it started ou"`
- **cross-del / locked**: guarded → guarded
  - v1: `target="Alpha beta gamma" doc="Before|Card|Alpha beta gamma|After" tree=p,x-card(x-title,x-note),p guard="locked node removed: x-card{\"data-edit\":\"locked\"}(x-title{}("`
  - v2: `target="Alpha beta gamma" doc="Bef|Card|Alpha beta gamma|After" tree=p,x-card(x-title,x-note),p guard="protect: selection clamped to before <x-card> (it started ou"`
- **enter / paragraph**: ok → ok
  - v1: `target="Alpha " doc="Before|Alpha |beta gamma|After" tree=p,p,p,p`
  - v2: `target="Alpha " doc="Before|Alpha |beta gamma|After" tree=p,p,p,p dupId=no guard="protect: dropped duplicate id=\"t\" from a second <paragraph>"`
- **enter / container**: ok → ok
  - v1: `target="Alpha " doc="Before|Left|Alpha |beta gamma|Right|Other|After" tree=p,div(div(h3,p,p),div(h3,p)),p`
  - v2: `target="Alpha " doc="Before|Left|Alpha |beta gamma|Right|Other|After" tree=p,div(div(h3,p,p),div(h3,p)),p dupId=no guard="protect: dropped duplicate id=\"t\" from a second <paragraph>"`
- **enter / free**: ok → ok
  - v1: `target="Alpha " doc="Before|Card|Alpha |beta gamma|After" tree=p,x-card(x-title,x-note,x-note),p`
  - v2: `target="Alpha " doc="Before|Card|Alpha |beta gamma|After" tree=p,x-card(x-title,x-note,x-note),p dupId=no guard="protect: Enter split <x-note> in two (id dropped from the se"`
- **enter / locked**: guarded → guarded
  - v1: `target="Alpha beta gamma" doc="Before|Card|Alpha beta gamma|After" tree=p,x-card(x-title,x-note),p`
  - v2: `target="Alpha beta gamma" doc="Before|Card|Alpha beta gamma|After" tree=p,x-card(x-title,x-note),p dupId=no`
- **enter / island**: guarded → guarded
  - v1: `target="Alpha beta gamma" doc="Before|□|After" tree=p,island,p`
  - v2: `target="Alpha beta gamma" doc="Before|□|After" tree=p,island,p dupId=no`
- **tab / container**: broken → broken
  - v1: `target="Alpha beta gamma" doc="Before|Left|Alpha beta gamma|Right|Other|After" tree=p,div(div(h3,p),div(h3,p)),p focus=body`
  - v2: `target="Alpha beta gamma" doc="Before|Left|Alpha beta gamma|Right|Other|After" tree=p,div(div(h3,p),div(h3,p)),p focus=button`
- **select-all-type / locked**: guarded → guarded
  - v1: `target="Alpha beta gamma" doc="Before|Card|Alpha beta gamma|After" tree=p,x-card(x-title,x-note),p guard="locked node removed: x-card{\"data-edit\":\"locked\"}(x-title{}("`
  - v2: `target="Alpha beta gamma" doc="Before|Card|Alpha beta gamma|After" tree=p,x-card(x-title,x-note),p guard="locked node removed: x-card{\"data-edit\":\"locked\"}(x-title{\"i"`
- **select-all-del / locked**: guarded → guarded
  - v1: `target="Alpha beta gamma" doc="Before|Card|Alpha beta gamma|After" tree=p,x-card(x-title,x-note),p guard="locked node removed: x-card{\"data-edit\":\"locked\"}(x-title{}("`
  - v2: `target="Alpha beta gamma" doc="Before|Card|Alpha beta gamma|After" tree=p,x-card(x-title,x-note),p guard="locked node removed: x-card{\"data-edit\":\"locked\"}(x-title{\"i"`
- **cut-paste / free**: ok → ok
  - v1: `target="Alpha gammabeta " doc="Before|Card|Alpha gammabeta |After" tree=p,x-card(x-title,x-note),p`
  - v2: `target="Alpha gammabeta " doc="Before|Card|Alpha gammabeta |After" tree=p,x-card(x-title,x-note),p guard="protect: pasted 1 block as text inside <x-note> (line breaks"`
- **cut-paste / locked**: ok → ok
  - v1: `target="Alpha gammabeta " doc="Before|Card|Alpha gammabeta |After" tree=p,x-card(x-title,x-note),p`
  - v2: `target="Alpha gammabeta " doc="Before|Card|Alpha gammabeta |After" tree=p,x-card(x-title,x-note),p guard="protect: pasted 1 block as text inside <x-note> (line breaks"`
- **paste-html / free**: ok → guarded
  - v1: `target="Alpha Ext bold" doc="Before|Card|Alpha Ext bold|item onebeta gamma|After" tree=p,x-card(x-title,x-note,ul(li(p))),p into=DIV`
  - v2: `target="Alpha Ext bolditem onebeta gamma" doc="Before|Card|Alpha Ext bold□item onebeta gamma|After" tree=p,x-card(x-title,x-note(br)),p into=DIV guard="protect: pasted 2 blocks as text inside <x-note> (line break"`
- **paste-html / locked**: guarded → guarded
  - v1: `target="Alpha beta gamma" doc="Before|Card|Alpha beta gamma|After" tree=p,x-card(x-title,x-note),p into=DIV guard="locked node structure changed: x-card{\"data-edit\":\"locked\"}("`
  - v2: `target="Alpha Ext bolditem onebeta gamma" doc="Before|Card|Alpha Ext bold□item onebeta gamma|After" tree=p,x-card(x-title,x-note(br)),p into=DIV guard="protect: pasted 2 blocks as text inside <x-note> (line break"`
- **slash-h2 / free**: ok → guarded
  - v1: `target=null doc="Before|Card|Alpha beta gamma |After" tree=p,x-card(x-title,h2),p`
  - v2: `target="Alpha beta gamma " doc="Before|Card|Alpha beta gamma |After" tree=p,x-card(x-title,x-note),p guard="protect: turn-into refused inside <x-note>"`
- **slash-h2 / locked**: guarded → guarded
  - v1: `target="Alpha beta gamma " doc="Before|Card|Alpha beta gamma |After" tree=p,x-card(x-title,x-note),p guard="locked node structure changed: x-card{\"data-edit\":\"locked\"}("`
  - v2: `target="Alpha beta gamma " doc="Before|Card|Alpha beta gamma |After" tree=p,x-card(x-title,x-note),p guard="protect: turn-into refused inside <x-note>"`
- **slash-list / free**: ok → guarded
  - v1: `target=null doc="Before|Card|Alpha beta gamma |After" tree=p,x-card(x-title),ul(li(p)),p`
  - v2: `target="Alpha beta gamma " doc="Before|Card|Alpha beta gamma |After" tree=p,x-card(x-title,x-note),p guard="protect: turn-into refused inside <x-note>"`
- **slash-list / locked**: guarded → guarded
  - v1: `target="Alpha beta gamma " doc="Before|Card|Alpha beta gamma |After" tree=p,x-card(x-title,x-note),p guard="locked node structure changed: x-card{\"data-edit\":\"locked\"}("`
  - v2: `target="Alpha beta gamma " doc="Before|Card|Alpha beta gamma |After" tree=p,x-card(x-title,x-note),p guard="protect: turn-into refused inside <x-note>"`
- **underline / locked**: guarded → guarded
  - v1: `target="Alpha beta gamma" doc="Before|Card|Alpha beta gamma|After" tree=p,x-card(x-title,x-note),p html=plain guard="mark \"underline\" not allowed in locked <x-card> (allowed: bo"`
  - v2: `target="Alpha beta gamma" doc="Before|Card|Alpha beta gamma|After" tree=p,x-card(x-title,x-note),p html=plain guard="mark \"underline\" not allowed in locked <x-note> (allowed: bo"`
- **delete-widget / paragraph**: ok → ok
  - v1: `n/a: no widget for schema nodes`
  - v2: `n/a: no element to delete (the delete UI covers generic nodes, containers and islands)`
- **delete-widget / container**: ok → ok
  - v1: `n/a: no widget for schema nodes`
  - v2: `target=null doc="Before|Right|Other|After" tree=p,div(div(h3,p)),p widget=shown overlay=1 summary="Delete <div> · 2 elements inside · 3 words"`
- **delete-widget / free**: ok → ok
  - v1: `target=null doc="Before|After" tree=p,p widget=shown boxes=2 badge="removes 2 elements · 3 words"`
  - v2: `target=null doc="Before|Card|After" tree=p,x-card(x-title),p widget=shown overlay=1 summary="Delete <x-note> · 3 words"`
- **delete-widget / locked**: ok → ok
  - v1: `target=null doc="Before|After" tree=p,p widget=shown boxes=2 badge="removes 2 elements · 3 words"`
  - v2: `target=null doc="Before|Card|After" tree=p,x-card(x-title),p widget=shown overlay=1 summary="Delete <x-note> · 3 words"`
- **delete-widget / island**: ok → ok
  - v1: `target=null doc="Before|After" tree=p,p widget=shown boxes=4 badge="removes 4 elements · 1 words"`
  - v2: `target=null doc="Before|After" tree=p,p widget=shown overlay=1 summary="Delete <x-card> · 4 elements inside · 1 word"`
