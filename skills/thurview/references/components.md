# Components

`data.yaml` holds typed inputs. `review.md` references them by id. Validation
is strict: an unknown key fails `publish`. This file holds `data.yaml` and the
two ways prose opens code; read [Diagrams](diagrams.md) only when you draw one.

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
  dryRun:                                 # one per interface the change moved
    name: thurview publish --dry-run      # what a consumer types or calls
    change: added                         # added | changed | removed
    capability: Validate a review without sealing a revision.
    anchor: dryRunFlag                    # must hold a line the diff moved

architecture:                             # a review only; required once it anchors a claim
  view: Retry policy now lives in RetryPolicy, the one place callers reach.
  defects:                                # each one the change introduces or deepens
    - cause: upload() special-cases a 4xx that sync() still retries.
      target: One RetryPolicy the caller passes in.
      step: Move both checks into it in this change.
      anchor: retryGuard                  # a head anchor, with a peek

security:                                 # a review only; omit until you have looked
  - boundary: The --shell flag reaches execFile's argv unquoted.
    anchor: spawn                         # a head anchor, with a peek

searches:                                 # an explainer only
  spawnCallers:
    pattern: '\bspawnPty *\('            # git grep -E, re-run at the pinned commit
    paths: ["src/"]                       # optional git pathspecs; the whole commit when left out
    why: who opens a PTY                  # optional; the question it answered
```

An anchor without `peek` can label a map node but cannot open code.

## interfaces

The browser shows the interface delta above the document: what the change
added to, changed in or removed from the surfaces something outside it reaches.
You declare each entry; thurview checks it.

Every entry has `name`, `change`, `capability` and `anchor`:

- **`name`** is what a consumer types or calls: an exported function, a CLI
  subcommand or flag, an HTTP route, an event kind, a config key, a file
  format.
- **`change`** is `added`, `changed` or `removed`.
- **`anchor`** proves it. `publish` checks it against the pinned diff - a
  `removed` entry needs a `graph: base` anchor covering a deleted line, `added`
  and `changed` need a head anchor covering an added line - so an entry is
  evidence, not a claim, and cannot outlive the code that moved it.
- **`capability`** is what a consumer can now do, or can no longer do. Write
  "`thurview publish` gains `--dry-run`", not "added a boolean to
  PublishOptions".

An entry written with `symbol:` named a row thurview used to derive. It derives
none now, and `publish` refuses the key with how to write the entry instead.

## architecture

The view this review takes on the design, first in the scope because a design
defect outlives every bug it causes. The lens - the patch test, the defects a
diff shows and how to confirm each - is defined once, in
[Architecture](architecture.md). Nothing here repeats it.

**Every review has one.** A review may leave the key out only while it is the
stub published before the walkthrough: the first anchored claim makes it a
review, and `publish` then refuses it without a view. The panel shows "not
assessed" on the stub and never after.

- **`view`** is required: one or two sentences on what the change does to the
  design. With no defect, it says why the change fits - "fits" with no reason
  is the same silence as no answer.
- **`defects`** lists each defect the change introduces or deepens. `cause` is
  the design property that lets the bug be written, `target` the shape that
  removes it, `step` the smallest move toward that shape and whether it belongs
  in this change. `anchor` is a head anchor with a `peek`: the defect as the
  change leaves it.

`publish` refuses a defect with an unknown anchor, an anchor with no `peek` or
a `graph: base` anchor, and one missing any of its four fields. Resolving a
defect marks its anchor used. An explainer surfaces structure without grading
it and a design proposes it, so `publish` refuses the key on either.

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

## searches

An explainer's record of what it searched: the callers, tests and importers
it looked for while reading the code. `publish` re-runs each one with
`git grep -I -E` at the pinned commit, so what it matched is the commit's and
not the worktree's, and the Coverage tab counts every file in scope it matched
and nothing anchored or placed as _matched by a search_. A search that matched
nothing is listed too, since that zero is what a claim of absence rests on.

- **`pattern`** is a POSIX extended regular expression, as `git grep -E` reads
  it. One git refuses fails the publish with git's own message.
- **`paths`** are git pathspecs to search under, read exactly as your own
  `git grep` reads them, so `*test*` reaches into every directory; the whole
  commit when left out.
  Coverage counts only the files inside the explainer's scope either way.
- **`why`** is the question the search answered, in a sentence.

A review or a design has no Coverage tab, so `publish` refuses `searches` there:
put the search beside the claim it supports, in the prose. The recipes are in
[Searching the code](searching.md).

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

The diagram fences - `sequence`, `callstack`, `flow` and `database` - and how
to pick one are in [Diagrams](diagrams.md).
