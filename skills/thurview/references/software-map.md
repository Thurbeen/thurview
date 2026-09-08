# Software map

## What it is for

The Files tab already answers *which lines changed*. The map answers the one
question no other tab does: **where the change landed in the system, and what
sits next to it.** A reader opens it to find out which parts the diff touched,
what those parts connect to, and therefore what could break that the diff
never mentions — and where to start reading.

That makes the map a reviewing instrument, not a picture of the architecture.
The Map tab reads it that way: parts the change touched are drawn before the
parts it did not, a part carrying changed files says how many, links into a
changed part are marked as the seams where two sides can fall out of step, and
the reader is offered one part to start at. A node that answers none of *where
did the change land*, *what does it sit next to*, *where do I start* does not
sit there harmlessly — it makes the ones that do harder to find.

Write it, then read it as the reader: does it send someone to the part of the
change that needs attention faster than scrolling the diff would? If not,
either cut nodes until it does, or ship no map at all.

## When to ship without a map

`nodes: []` is a real answer, not a gap. A map that adds nothing costs the
reader a tab they open, learn nothing from, and distrust on the next review.
An absent one costs nothing.

Ship without a map when:

- The change lands in one place and stays there. The Files tab already says
  where it is; a map would only restate it with rounded corners.
- Every part you could name is a file the diff already lists. The map would be
  the Files tab with fewer details.
- The repository has no structure worth naming at review scale — a handful of
  modules with no boundary between them.

Author one when:

- The change crosses a boundary: one part now calls, stores or serves
  something another part owns.
- It adds or removes a part, so the shape of the system is different after it.
- What the change touches is used by code the diff does not show, and the
  reader has to know what that is before judging it.
- The review is an architecture review. There the map is the subject, not the
  orientation for one.

When you skip it, say so in the handover, with the reason, in one line. Silence
reads as an oversight.

## What to model

Model the people, systems, containers, components and code elements a reader
must hold in mind to judge **this** change. Do not model incidental
implementation detail, and do not aim for completeness: an exhaustive map and
no map cost the reader about the same. For a large repository, keep the top
level small and put detail one level down, so the first screen is a short list
of places the change could be.

## Schema

`map.yaml` describes the repository structure at head, and optionally at base,
as nested nodes.

```yaml
nodes:
  - { id: app, kind: system, label: Review app, description: Local server and UI }
  - { id: app.cli, kind: container, label: CLI, files: ["src/cli.ts"] }
  - { id: app.server, kind: container, label: Server, files: ["src/server/**"] }
  - { id: app.server.threads, kind: component, label: Threads, files: ["src/threads.ts"], anchor: createThread }
  - { id: reader, kind: person, label: Reader }
edges:
  - { from: reader, to: app.server, label: reviews in the browser }
  - { from: app.cli, to: app.server, label: publishes revisions }
base:                      # optional: structure at the base commit
  nodes: [...]
  edges: [...]
```

Rules:

- `id` is a dot path. Every parent must exist as a node (`app` before
  `app.cli`). Identity is the id; keep ids stable between base and head.
- `kind`: `person`, `system`, `container`, `component`, `code`.
- `files`: globs relative to the repository root (`*`, `**`, `?`). They link
  the node to changed files in the Files tab, and they are what makes a node
  say how much of the change it holds. A glob matching nothing at the pinned
  commit is a warning.
- `anchor`: an anchor id from `data.yaml` that opens representative code. Give
  one to every node the change touched; it is the shortest path from the map
  to the code.
- Edges reference node ids. Labels are short verbs.

## Base and head

Work base first, then apply only the structural changes of the diff to get
head. That is what lets the tab say *added*, *removed* and *changed* rather
than *touched*, and those three words are most of what a reader takes from the
map. Without `base`, nodes touched by the diff show as changed and nothing
shows as added or removed.

`thurview publish` validates the map with the document; map errors block
publication like document errors. An empty `nodes: []` means no map.
