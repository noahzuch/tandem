- diagram box: Delete <div> · 6 elements inside · 16 words; overlay 684×170 at 335,365; 6 descendants measured, 0 without a box
- x-card: Delete <x-card> · 4 elements inside · 17 words; overlay 684×70 at 335,415
- island figure: Delete <svg> · 16 elements inside · 1 word; overlay 684×128 at 335,387; no box: <defs>, <marker>, <path>, <g>, <line>, <line>
- hard css: Delete <div> · 12 elements inside · 28 words · 1 hidden · 1 off-screen; overlay 684×162 at 335,379
    <div> "display:contents wrapper (no" → no box — display:contents → no box (children are boxed)
    <span> "display:contents wrapper (no" → 269×16
    <div> "overflow:hidden — only 24px " → 666×24
    <div> "overflow:hidden — only 24px " → 664×23 — clipped by overflow:hidden ancestor
    <div> "zero-size wrapper, visible c" → no box — zero size → no box
    <span> "zero-size wrapper, visible c" → 68×108 — outside the node box (absolute/transform)
    <div> "grid col 3 (DOM first)grid c" → 666×29
    <div> "grid col 3 (DOM first)" → 218×29
    <div> "grid col 1 (DOM second)" → 218×29
    <div> "positioned off-screen" → 130×21 — off-screen (position far away); outside the node box (absolute/transform)
    <div> "visibility:hidden" → 666×21 — invisible (visibility/opacity) but boxed
    <div> "rotated" → 65×41 — transformed → axis-aligned bounding box
- keyboard path: Escape → node:div.node → node:div.diagram-box; Backspace → confirm bar; Enter deletes; Esc keeps
