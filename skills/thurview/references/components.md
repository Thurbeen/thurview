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
