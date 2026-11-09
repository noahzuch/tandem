# From feature page to spec

How a feature page in this folder (`‹NN›-‹slug›.html`, badge "specification pending") becomes a full spec.
The process is run by an agent together with the user; the user decides, the agent researches, proposes and writes.

Inputs:

- the feature page — overview, what the spikes settled, open points, links;

From branch `spike` (read it in a worktree: `git worktree add ../tandem-spike spike`):
- `SUMMARY.html` — the sections and notes (`#nX`) the feature page links;
- the spikes (`NN-…/`) — README and code;

From `main`:
- [`docs/architecture/`](../architecture/index.html) and [`docs/adr/`](../adr/) — the system as it is now and the
  decisions that bind every feature;

From the templates/ folder:
- [`templates/spec-template.html`](templates/spec-template.html) — the structure and the rules for every section,
  in its HTML comments;
- [`templates/spec-example.html`](templates/spec-example.html) — the same template filled in for a mock system;
- the diagram templates in [`templates/`](templates/) — which diagram to use when, and the parts to build it from.

## Spikes are evidence, not a blueprint

The spikes were throwaway experiments. They were written fast to answer one question each, so expect bugs, shortcuts,
hard-coded values, missing error handling and things nobody thought of. Treat them accordingly:

- **Every decision a spike made is open until revalidated.** That includes the explicit ones (library, data format,
  protocol) and the implicit ones a spike made just by being written a certain way (a limit, a default, an error that
  is swallowed, a file layout, a UI behaviour). "The spike did it" is not a reason.
- **What was measured counts; what was assumed doesn't.** A finding backed by a measured scenario is strong evidence.
  A choice that merely worked in the demo is a hypothesis.
- **The spike's feature set is not the target.** A spike contains what its question needed. It has features the
  product doesn't want and lacks features the product needs (error handling, edge cases, security, persistence,
  multiple users, accessibility, upgrades …).
- **The spike's code is not the design.** Its structure was never designed. The building blocks of the spec are
  designed fresh; spike code is at most a reference for how an API behaves.

The feature page's "What the spikes settled" list is a summary of spike results, so the same applies to it.

## Ground yourself

Read the feature page, then everything it links: the SUMMARY sections and notes, the spike READMEs, and the spike
code where a README is vague. Read the neighbouring feature pages (and their specs, once they exist) to know where
this feature ends. Read the spec template and the example in full before the first brainstorming question, so you
know what the result has to contain.

## Audit the spikes

Before brainstorming, consider this:

- **Decisions.** Every decision the spikes made that touches this feature. For each: what was decided, the evidence
  (measured, observed in a demo, or assumed), known bugs and shortcuts, and your recommendation — keep, revisit or
  drop — with the reason.
- **Spike features.** What the spikes built, each marked as needed, unclear or not wanted.
- **Gaps.** What the product needs that no spike covered: missing behaviour, unhandled failure cases, edge cases,
  constraints from neighbouring features.

These are not indisputable Facts but input to consider.

## Brainstorm with the user

Use the `nessy:brainstorming` skill.
Work through the spec in the template's order, one section at a time, and agree on each before moving on:
Goal (problem, outcome, non-goals) → Functional design → Context → Solution design → Building blocks → Decisions.
The goal comes first even if the spikes seem to imply it: what the feature must achieve decides which spike
decisions survive.

## Write the spec

Copy `templates/spec-template.html` to `‹NN›-‹slug›.html` in this folder, replacing the feature page. Then fill it.

Rules for the spec:

- **Self-contained.** The spec states every decision with its rejected alternatives in its Decisions table instead
  of linking a journal entry. It never links the spike summary or a spike folder; a spike may be mentioned as a soft
  reference — branch `spike` and a path, as text.
- **Binding decisions get an ADR.** A decision that later features must follow is also written as an ADR in
  [`docs/adr/`](../adr/), or supersedes an existing one.

## Brainstorming journals

The journal (`‹NN›-‹slug›-decisions.md`, next to the feature page) keeps decisions from getting lost while the spec is
being designed. It is a working note: git-ignored and never committed. Once the spec is written, everything accepted
in it is in the spec, and the binding parts are in ADRs.

## After the spec

A spec is frozen once its feature is implemented; it is not updated afterwards. What changes instead are the living
documents: implementing a feature includes updating [`docs/architecture/`](../architecture/index.html), the ADRs and,
where needed, README.md and CONTRIBUTING.md. A feature is done only when they describe the system as it now is.
