# Components

`data.yaml` holds typed inputs. `review.md` references them by id. Validation
is strict: an unknown key fails `publish`.

## data.yaml

```yaml
actors:
  agent: { label: Agent }
  server: { label: Server, map: system.server }   # map: optional node id

anchors:
  spawn:
    title: PTY spawn site                 # required
    detail: Cold-path fallback branch     # optional, shown with the peek
    map: system.server                    # optional node id
    peek:                                 # required for links, peeks and diagrams
      file: src/pty.ts                    # path at the pinned commit
      from: 214                           # 1-based, inclusive
      to: 223                             # >= from
      graph: head                         # head (default) or base

stores:
  reviewDb:
    kind: relational                      # relational (tables) or document (documents)
    label: review.db
    tables:
      threads:
        label: threads                    # optional
        key: id                           # optional
        schema:
          id: { type: text, pk: true }
          body: { type: text }

interfaces:
  spawnPty:                               # annotate a derived entry
    symbol: src/pty.ts:spawnPty           # an id from `thurview graph interfaces`
    capability: Callers get a sized PTY without knowing the fallback.
  dryRun:                                 # declare one the graph cannot see
    name: thurview publish --dry-run      # what a consumer types or calls
    change: added                         # added | changed | removed
    capability: Validate a review without sealing a revision.
    anchor: dryRunFlag                    # must hold a line the diff moved

security:                                 # a review only; omit until you have looked
  - boundary: The --shell flag reaches execFile's argv unquoted.
    anchor: spawn                         # a head anchor, with a peek
```

An anchor without `peek` can label a map node but cannot open code.

## interfaces

The browser shows the interface delta above the document. thurview derives it
at `publish` from the code graph at both pinned commits - every symbol the
diff touched that is visible outside its own file, split into added, changed
and removed - so the list itself is never authored and never goes stale.

Each entry in `interfaces` does one of two things, and never both:

- **`symbol`** annotates a derived entry with `capability`, one sentence in a
  consumer's terms. `publish` fails when the change did not move that symbol,
  so an annotation cannot outlive the entry it explains. Take the id verbatim
  from `thurview graph interfaces`.
- **`name`** declares an interface the graph cannot see: a CLI subcommand or
  flag, an HTTP route, an event kind, a config key, a file format. It needs
  `change` and an `anchor`. `publish` checks the anchor against the pinned
  diff - a `removed` entry needs a `graph: base` anchor covering a deleted
  line, `added` and `changed` need a head anchor covering an added line - so a
  declared interface is evidence, not a claim.

`capability` is what a consumer can now do, or can no longer do. Write
"`thurview publish` gains `--dry-run`", not "added a boolean to
PublishOptions".

## security

Where this change lets input cross a trust boundary. The browser shows it under
the interface delta, so the reader is told either way rather than left to
remember to look for it.

**What counts as a trust boundary is defined once**, in the `thurview-fix`
skill's `SKILL.md` under "Findings". Read it there. Nothing here repeats it, so
the two cannot drift into disagreeing about what counts. That skill turns what
it names into a ranked finding; this one only puts the place in front of the
reader, so the same definition selects the lines and stops there.

Three states, and they are three different claims:

- **omitted**, or the word `pending` - you have not looked yet. The panel says
  "not assessed", which is what a stub published before the walkthrough should
  be saying.
- **`security: none`** - you looked, and the change crosses none. Say it
  explicitly: it is what makes this panel worth reading the next time.
- **a list** - one entry per place. `boundary` is one sentence in the reader's
  terms; `anchor` is a head anchor with a `peek`, because a crossing is the
  boundary as the change leaves it.

`publish` refuses an unknown anchor, an anchor with no `peek` and a `graph: base`
anchor: an anchor that opens nothing is how a reader stops trusting the ones that
do. It also refuses an empty list - write `none` rather than leave the reader to
work out which of the two you meant. Resolving a crossing marks its anchor used,
so an anchor that only a crossing names raises no "defined but never used".

There is no severity here. A crossing is a place for the reader to look; the
severity that exists belongs to the findings in `thurview-fix`, not to this
document. An explainer and a design are pinned to one commit and have no change,
so `publish` refuses the key on either.

## Anchor link

```markdown
[the spawn site](anchor:spawn)
```

Opens the range in the side peek. The anchor needs a `peek`.

## peek

````markdown
```peek
spawn
```
````

Renders the range inline with title, path and detail.

## sequence

````markdown
```sequence
label: Open a trace quote
messages:
  - { from: agent, to: server, label: "startLogin(cols, rows)", anchor: spawn }
  - { from: server, to: server, label: "spawnPty(dims)", code: "spawnPty(dims)" }
  - { from: server, to: { label: CLI }, label: ready, anchor: ready }
```
````

`from` and `to` are actor ids or an inline `{ label }`. Each message needs an
`anchor` (peekable) or `code` (a string, or `{ language, text }`). Clicking a
message opens its anchor.

## callstack

````markdown
```callstack
title: Warm allocation
base: [reconcile, auth, enqueueWork]
head:
  - reconcile
  - enqueueWork
  - { calls: [enqueueWork, processItem], reason: dispatched via the work queue }
```
````

Rules:

1. List order is the stack; each frame calls the one below it.
2. One anchor per frame, at the call site or the function head.
3. The diff is positional over anchor identity. A frame kept in both stacks
   is one head-graph anchor listed in both lists; it renders as context.
4. A frame only in `base` is a removed call; its anchor must use
   `graph: base`. Frames in `head` must use head anchors.
5. `{ calls: [parent, child], reason }` marks a hop that is hard to follow
   (queue, callback, RPC). It renders the child with a dashed `≈`.
6. One component is one linear stack. Use two for two flows.
7. `publish` checks each `-` frame against deleted lines and each `+` frame
   against added lines in the pinned diff. Listing a frame on one side only
   for contrast is rejected.

## flow

````markdown
```flow
label: Sign in
steps:
  - { id: land,  label: Visitor opens /login, actor: visitor, next: post }
  - { id: post,  label: Credentials posted,   anchor: loginRoute, next: check }
  - { id: check, label: Credentials valid?,   anchor: checkUser,
      when: [{ case: valid, to: home }, { case: rejected, to: retry }] }
  - { id: retry, label: Error shown,          anchor: renderError, next: post }
  - { id: home,  label: Dashboard,            anchor: dashboard }
```
````

A user journey and where it branches - the shape `sequence` cannot hold,
because a decision is not a message. The first step is the entry; a step
continues with `next` or branches with `when`, and one with neither ends the
flow. Cycles are fine: a retry loop is what a journey does, and a step that
leads back up is drawn down the right-hand lane.

Every step is either code or a person: `anchor` is where the code does it and
the reader opens it by clicking, `actor` is a declared actor doing it outside
the code, and a step carries at least one of the two. An actor-only step is
drawn dashed, so the reader can see at a glance which parts open something.

`publish` refuses:

1. A step with neither `anchor` nor `actor`, and a block where no step has an
   `anchor` at all - a flow nothing opens is prose in a box.
2. `next` and `when` on one step, and a `when` with a single case. One is a
   branch, the other is a `next`.
3. A `next` or `to` naming a step the block does not declare, or naming itself.
4. A step unreachable from the first one, a duplicate `id`, an unknown `actor`,
   and an anchor with no `peek`.

## Fences thurview does not render

`mermaid`, `plantuml`, `puml`, `dot`, `graphviz` and `d2` in a document body are
a publish error. They used to be neither components nor an error, so the block
reached the reader as its own source text with nothing saying so. thurview draws
only what it can anchor at the pinned commit: use `flow` for a journey and
`sequence` for a message exchange.

## database

````markdown
```database
title: Thread storage
stores: [reviewDb]
usecases:
  - id: resolve
    label: Resolve a thread
    summary: optional one-liner
    ops:
      - { op: read,  store: reviewDb.threads,      actor: agent, label: load open threads, anchor: loadThreads }
      - { op: write, store: reviewDb.threads.body, actor: agent, label: mark resolved,     anchor: markResolved }
```
````

`store` is `storeId.collection` or `storeId.collection.field`. A read flows
store to actor; a write flows actor to store; `op` sets the direction. Every
store used must be listed in `stores`. Every `actor` must exist in
`data.yaml`. Add this component only when a storage view materially helps.
