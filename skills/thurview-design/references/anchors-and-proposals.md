# Anchors and proposals

thurview's one promise is that a claim about code can be opened. An anchor is a
file and a line range at a pinned commit; the reader clicks it and sees the
code. A review and an explainer both keep that promise trivially, because the
code they describe is written.

A design describes code that is **not written yet**. This file is how the kind
keeps the same promise anyway.

## The rule

> **An anchor is evidence, never a proposal.**
>
> Every anchor in a design document resolves to real code at the one pinned
> commit. Code the design would write is not anchored. It is declared as a
> **proposal**, and the proposal names the **site** — the anchor of the code it
> lands in, replaces or plugs into today.

So an anchor means exactly one thing in all three kinds, and the reader never
has to ask which sort of anchor they are looking at. One anchor that resolves
to nothing would put that question on every other anchor in the document.

## What this buys, concretely

| The design says                                | How it is carried                                    | What the reader can do                        |
| ---------------------------------------------- | ---------------------------------------------------- | --------------------------------------------- |
| "today the router picks a handler in a switch" | anchor with a `peek`                                 | open the switch                               |
| "we would add `Router.register`"               | proposal, `change: added`, anchored at the switch    | open the code it replaces                     |
| "it would look roughly like this"              | plain fenced code block in `review.md`               | read it as a sketch, because it is not a peek |
| "these fourteen callers move"                  | anchor per caller, or the count from `graph callers` | check the count                               |

## The refusals, and why each one is there

`thurview publish` refuses a design that breaks the rule. Each message says
why; these are the reasons behind them.

- **`graph: base` on an anchor.** A design has one pinned commit. A base-graph
  anchor would resolve against a commit the document never named.
- **A `symbol:` interface entry.** That shape annotates a row the code graph
  derived from a diff. A design has no diff, so there is no derived row, and an
  annotation with nothing under it is an assertion wearing a badge.
- **A design that proposes nothing.** A document with no `interfaces` entry is
  prose about the code as it stands. That is an explainer, and it should be one
  — the reader of a design is being asked to approve something.
- **A proposal whose anchor does not resolve, or has no `peek`.** The site is
  the whole point of the entry. Without it the proposal floats.

The map follows the same line, in its own terms: a node under `base` whose
`files` globs match nothing at the pinned commit is a wrong claim about today
and gets a warning, while a node under `nodes` that owns no file yet is a
proposed part and gets none.

## The boundary of the kind

**Greenfield is out of scope.** A design that lands nowhere in an existing
codebase has no site to anchor and nothing for the reader to check against.
thurview would give it a nice page and no evidence, which is worse than a
markdown file, because the page implies evidence.

When the request is greenfield, say that, and write ordinary prose. When it is
mostly greenfield with one integration point, the integration point is the
site: anchor there, and be honest in the document that the rest is unanchored.

## Writing a proposal that earns its entry

Each entry is one line in the panel above the document, so it has to be worth
the reader's attention.

```yaml
interfaces:
  routeTable:
    name: Router.register(path, handler)
    change: added
    capability: A feature registers its own route instead of editing the switch.
    anchor: dispatch
```

- `name` is what a consumer types or calls — a signature, a CLI flag, an HTTP
  route, a config key, a file format. Not a component name, not a task.
- `change` is `added`, `changed` or `removed`. `removed` is the entry a reader
  must not miss, and the panel sorts it first.
- `capability` is what somebody can now do, in their words. "Adds a register
  method" is the signature again; "a feature registers its own route instead of
  editing the switch" is the reason the design exists.
- `anchor` is the site, and it is what makes the entry checkable.

One entry per interface, not one per task. An implementation plan with eleven
steps and two interface changes has two entries; the eleven steps are prose,
and the reader decides on the two.
