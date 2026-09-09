# Code explainer

A **review** explains a change. An **explainer** explains a codebase, or one
subsystem of it, at a single pinned commit, so the reader can see the
architecture well enough to spot design problems themselves.

Same engine, different unit. It shares anchors, peeks, the map, threads,
revisions and the publish → wait → answer loop. It has no diff, no commits and
no interface delta, because those are claims about a change and there is no
change. Where a review shows the interface delta, an explainer shows
**coverage**: what it examined at that commit, and what it did not.

| Tab           | Review                             | Explainer                                     |
| ------------- | ---------------------------------- | --------------------------------------------- |
| Review        | the walkthrough, with the delta    | **Explainer**: the document, with coverage     |
| Files         | split diff of the changed files    | absent                                         |
| Commits       | base..head                         | absent                                         |
| Map           | parts, marked added/changed/removed | parts at the pinned commit                    |
| Coverage      | absent                             | **what the document reached, and what it did not** |
| Threads       | ask, comment, decide               | same, and the decision reads *Done reading* / *Send it back* |

## When to write one

Write an explainer when the request is about the code as it stands: "explain
this codebase", "how does the server work", "walk me through `src/graph`",
"I want to see the architecture". Write a review when the request is about a
change: a branch, a pull request, a range.

If the request is a change, do not reach for an explainer because the change is
large. A large change is still a change.

## The document kind, in one command

```sh
thurview explain                 # the whole repository at HEAD
thurview explain src/server      # one subsystem
thurview explain --commit v1.2.0 # a released commit rather than HEAD
```

The positional argument is a path or a glob; a bare path means that directory
and everything under it. It is the **scope**, and everything else obeys it:
`graph architecture` reports the clusters inside it, and coverage accounts for
every file inside it. A scope that matches no file at that commit is refused.

Record `explainer.id`, `explainer.dir`, `explainer.commit`, `explainer.scope`
and `scale.filesInScope` from the output. Everywhere else the id is passed as
`--review <id>`; that flag names a document, whichever kind it is.

## Keeping it short without lying about it

A review is bounded by its diff. A codebase is not, and this is the hard part:
evidence-anchored prose over a whole repository either runs unreadably long or
quietly leaves most of the system out. Prose that leaves things out silently is
misleading about architecture, which is the one thing an explainer must not be.

So work in three layers, and let each carry what it is good at.

1. **System — the map carries breadth.** Author `map.yaml` first, seeded from
   `thurview graph architecture --review <id>`: communities become nodes, their
   files become the node's `files` globs, and the edges between communities
   become edges. Every part of the scope should appear here, including the parts
   the prose will not reach. See [Software map](software-map.md) for the shape.
2. **Subsystem — the prose carries depth.** Pick the parts that carry the most
   structure and the most traffic, and explain those. Three to six sections.
   Everything else stays on the map.
3. **File and symbol — anchors carry the proof.** Every claim gets an anchor.
   The reader opens code where they want it and nowhere else.

**Select by structure, not by taste, and say what you selected on.** The graph
gives you the basis: cluster size in files and symbols, the hub symbols of each
cluster (most referenced), and the reference counts on the edges between
clusters. Say in the document which parts you took and why they were the ones -
"the two clusters with the most traffic between them" is a reason a reader can
check. "The interesting bits" is not.

## Coverage is derived, not claimed

`thurview publish` accounts for every file in scope at the pinned commit and
puts one of three states on it:

- **explained** - an anchor in the document points into the file.
- **placed** - a map node's `files` globs match it, and no anchor does. The
  reader is told where it sits, not what it does.
- **not examined** - neither.

The counts go above the document and onto the Coverage tab, and `publish`
prints them with the files it did not examine. You cannot forget to state
coverage, and you cannot overstate it: to move a file out of *not examined* you
have to actually anchor it or actually place it on the map.

Two consequences worth planning for:

- **An explainer without a map counts everything the prose does not anchor as
  not examined.** `publish` warns when there is no map. That is a true
  statement, and usually not the one you want to make: author the map.
- **A broad glob is visible.** The Coverage tab lists each map node with the
  globs it owns and how many files they match, so `**/*` on one node inflates
  nothing quietly.

Coverage also states what the code graph could not read: files in languages it
does not parse (`thurview graph` covers TypeScript, JavaScript, Python, Go,
Rust and Java), and whether its file list was capped. Those files are absent
from the structure, not empty. If a large part of the scope is outside the
graph, say so in the document rather than letting the map imply the system is
smaller than it is.

## Surface structure; do not grade it

thurview's thesis holds here: *it does not review the code for you; it helps
you understand it fast enough to review it yourself.* An explainer exists so
the reader can **detect** design problems. That is only consistent with the
thesis if you surface structure and leave the conclusion to them.

The test: **every fact in an explainer is a count, or a list of named things,
at the pinned commit, that the reader could re-derive with `thurview graph`.**

Observation - write these:

- "`src/server` is referenced from four other parts; it references one."
- "`Store` is defined in `src/db.ts` and `src/cache.ts`."
- "The API layer reaches the database layer in 14 places and the model layer in
  2; the model layer reaches the API layer in 6."
- "Nothing in the scope references `legacy/` at this commit."
- "No test file reaches this cluster." (a count of zero, stated as one)

Judgement - never write these:

- "This violates separation of concerns."
- "The god object here should be split."
- severities, scores, "issues found", "critical", "smell", a ranked list of
  problems, or a recommendation section.

The difference is not tone. "A module with 14 inbound dependencies" is
something the reader acts on; "an over-coupled module" is a verdict they cannot
check. When you are unsure, write the count and stop. If a structure genuinely
worries you, the honest move is a question in the document - "the two stores
both define `Session`; whether that is one concept or two is not visible from
the code" - not a finding.

## Workflow

1. `thurview explain [<scope>]`. Note the id, the commit and the scope.
2. `thurview graph architecture --review <id>`. This is the structure at the
   pinned commit; do not re-derive it by reading directories.
   `thurview graph callers <name>` and `tests-for <name>` answer the follow-ups.
   `graph interfaces` and `graph impact` compare two commits and are refused.
3. Author `map.yaml` from the architecture output, covering the whole scope.
   Dispatch a sub-agent for it if you have one, exactly as a review does.
4. Author `review.md` and `data.yaml` per [Document authoring](document-authoring.md),
   minus the interface-delta section: an explainer has none, and declaring
   `interfaces` in `data.yaml` is an error. So is `graph: base` on an anchor -
   there is one commit.
5. `theme.yaml` as usual - see [Theme](theme.md).
6. `thurview publish --review <id>`. Read `coverage` and `notExamined`. If the
   split is not the one you meant, anchor or place more and publish again.
7. `thurview open --review <id>`, then `thurview wait --review <id>`. The loop,
   the statuses and the thread rules are identical to a review; see
   [Lifecycle](lifecycle.md).

## Hand over

In a few lines: the url, the scope and the commit, the coverage line in its own
words (including how many files were not examined), which parts you chose to
explain and on what basis, and that you are waiting for their questions. Do not
list the design problems you think you saw. The document is built so the reader
finds them.
