---
name: thurview-explain
description: Author and publish a thurview code explainer - a guided, evidence-anchored explanation of a codebase, or one subsystem of it, at a single pinned commit, which the reader opens in the browser, annotates, asks questions about, and sends back or marks done. Every claim is anchored to a file and line range, a software map carries the parts the prose does not reach, and coverage states what was never examined. Use when the user asks to explain or walk through a codebase, how a system or a subsystem works, where its design problems might be, "explain this repository", "how does the server work", or invokes /thurview-explain. Not for reviewing a change that is already written, which is the thurview skill.
user-invocable: true
argument-hint: "[<path scope>] [--commit <ref>]"
---

# thurview explain

A **review** explains a change. An **explainer** explains a codebase, or one
subsystem of it, at a single pinned commit, so the reader can see the
architecture well enough to spot design problems themselves.

Same engine, different unit. It shares anchors, peeks, the map, threads,
revisions and the publish → wait → answer loop with the `thurview` skill's
review. It has no diff, no commits and no interface delta, because those are
claims about a change and there is no change. Where a review shows the
interface delta, an explainer shows **coverage**: what it examined at that
commit, and what it did not.

| Tab      | Review                              | Explainer                                                    |
| -------- | ----------------------------------- | ------------------------------------------------------------ |
| Review   | the walkthrough, with the delta     | **Explainer**: the document, with coverage                   |
| Files    | split diff of the changed files     | absent                                                       |
| Commits  | base..head                          | absent                                                       |
| Map      | parts, marked added/changed/removed | parts at the pinned commit                                   |
| Coverage | absent                              | **what the document reached, and what it did not**           |
| Threads  | ask, comment, decide                | same, and the decision reads _Done reading_ / _Send it back_ |

## Which kind is this

Write an explainer when the request is about the code as it stands: "explain
this codebase", "how does the server work", "walk me through `src/graph`",
"I want to see the architecture".

| The request is about                                          | Kind          | Skill             |
| ------------------------------------------------------------- | ------------- | ----------------- |
| code that exists, explained - "how does this work"            | **explainer** | this one          |
| code that is written - a branch, a PR, a range                | review        | `thurview`        |
| code that is **not written yet** - "how should we build this" | design        | `thurview-design` |

If the request is a change, do not reach for an explainer because the change is
large. A large change is still a change. An explanation with a recommendation
stapled on is an explainer that broke its own rule - see "Surface structure; do
not grade it" below, and write the design instead when the request is genuinely
"explain this, then propose a change".

## Request

$ARGUMENTS

A path scope narrows the explainer to one part of the system; with none it is
the whole repository.

## Before authoring

Read the guidance files that exist, in this order; the second wins on conflict.

1. `~/.thurview/THURVIEW.md` (or `$THURVIEW_HOME/THURVIEW.md`), user guidance.
2. `THURVIEW.md` at the repository root, repository guidance.

`thurview explain` lists the ones it found under `guidance`.

The `thurview` skill ships the references this one shares - document authoring,
components, software map, searching the code, lifecycle. `thurview skill` prints the path of
every bundled SKILL.md; the references sit beside each one. Read **Document
authoring** before you write `review.md`, **Components** before you edit
`data.yaml`, **Software map** before you author `map.yaml`, **Searching the
code** before you look for callers, tests or importers, and **Lifecycle** for
statuses, storage and thread rules -
they are identical for all three kinds.

Run the CLI as `thurview`; `npx -y thurview` runs the published package with
the same commands. Every command prints TOON on stdout - the result, then
`help[]` with the next commands. Errors are structured on stdout too (`error`,
`code`, `help`); exit 1 is a failure, 2 a usage error. If a command answers
`unknown command` for something this skill tells you to run, the installed CLI
is older than the skill: run `thurview update`, retry once, then report it.

## The document kind, in one command

```sh
thurview explain                 # the whole repository at HEAD
thurview explain src/server      # one subsystem
thurview explain --commit v1.2.0 # a released commit rather than HEAD
```

The positional argument is a path or a glob; a bare path means that directory
and everything under it. It is the **scope**, and everything else obeys it:
your searches stay inside it, and coverage accounts for every file inside it. A scope that matches no file at that commit is refused.

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
   the code: the directories in scope become candidate nodes and their files
   the node's `files` globs, and what imports what between them becomes the
   edges. `git ls-tree -d -r --name-only <commit> -- <scope>` lists the
   directories; the `thurview` skill's Searching the code reference has the
   import recipes. Every part of the scope should appear here, including the
   parts the prose will not reach. See the `thurview` skill's Software map
   reference for the shape.
2. **Subsystem — the prose carries depth.** Pick the parts that carry the most
   structure and the most traffic, and explain those. Three to six sections.
   Everything else stays on the map.
3. **File and symbol — anchors carry the proof.** Every claim gets an anchor.
   The reader opens code where they want it and nowhere else.

**Select by structure, not by taste, and say what you selected on.** Your
searches give you the basis: how many files a part holds, which of its names
the rest of the scope references most, and how many places one part imports
another. Say in the document which parts you took and why they were the ones -
"the two parts that import each other most" is a reason a reader can check,
with the searches that counted it in `searches`. "The interesting bits" is not.

## Coverage is derived, not claimed

`thurview publish` accounts for every file in scope at the pinned commit and
puts one of four states on it, from what you did that it can check:

- **explained** - an anchor in the document points into the file.
- **placed** - a map node's `files` globs match it, and no anchor does. The
  reader is told where it sits, not what it does.
- **searched** - a search you recorded under `searches` in `data.yaml` matched
  it, and nothing above did. You saw lines of it; the document says nothing
  about it.
- **not examined** - none of the above.

Record the searches you ran - for callers, tests, importers - under `searches`,
each with its `pattern`, optional `paths` and a `why`. `publish` re-runs every
one with `git grep -E` at the pinned commit, so what it counts is what the
commit holds, not what you remember, and a search that matched nothing is shown
as the zero it is. The shape is in the `thurview` skill's Components reference,
the recipes in its Searching the code reference.

The counts go above the document and onto the Coverage tab, and `publish`
prints them with the files it did not examine. You cannot forget to state
coverage, and you cannot overstate it: to move a file out of _not examined_ you
have to actually anchor it, place it on the map, or search it.

Two consequences worth planning for:

- **An explainer without a map counts everything the prose does not anchor as
  not examined.** `publish` warns when there is no map. That is a true
  statement, and usually not the one you want to make: author the map.
- **A broad glob is visible.** The Coverage tab lists each map node with the
  globs it owns and how many files they match, so `**/*` on one node inflates
  nothing quietly.

Coverage is the same for every language: it counts files at the commit, so a
config file, a stylesheet or a language nothing parses is accounted for like
any other.

## Surface structure; do not grade it

thurview's thesis holds here: _it does not review the code for you; it helps
you understand it fast enough to review it yourself._ An explainer exists so
the reader can **detect** design problems. That is only consistent with the
thesis if you surface structure and leave the conclusion to them.

The test: **every fact in an explainer is a count, or a list of named things,
at the pinned commit, that the reader could re-derive with `git grep` or
`git ls-tree`.**

Observation - write these:

- "`src/server` is referenced from four other parts; it references one."
- "`Store` is defined in `src/db.ts` and `src/cache.ts`."
- "The API layer reaches the database layer in 14 places and the model layer in
  2; the model layer reaches the API layer in 6."
- "Nothing in the scope references `legacy/` at this commit."
- "No test file names anything in `src/store`." (a count of zero, stated as
  one, with the search that found it)

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
2. Survey the scope at the pinned commit: its directories and files
   (`git ls-tree`), then what imports what between them and who calls the
   names that recur, with the `git grep` recipes in the `thurview` skill's
   Searching the code reference. Record each search that shapes what you write
   under `searches` in `data.yaml`.
3. Author `map.yaml` from that survey, covering the whole scope.
   Dispatch a sub-agent for it if you have one, exactly as the `thurview`
   skill's review does.
4. Author `review.md` and `data.yaml` per **Document authoring**, minus the
   interface-delta section: an explainer has none, and declaring
   `interfaces` in `data.yaml` is an error. So is `security`, which is what a
   change carries input across and an explainer has no change. So is
   `graph: base` on an anchor - there is one commit.
5. `thurview publish --review <id>`. Read `coverage` and `notExamined`. If the
   split is not the one you meant, anchor, place or search more and publish
   again.
6. `thurview open --review <id>`, then `thurview wait --review <id>`. The loop,
   the statuses and the thread rules are identical to a review; see
   **Lifecycle**.
7. To share it beyond the browser, `thurview export --review <id> --out <path>`
   writes a static, read-only copy - see the `thurview` skill's **Sharing a
   copy that needs no server**.

## Hand over

In a few lines: the url, the scope and the commit, the coverage line in its own
words (including how many files were not examined), which parts you chose to
explain and on what basis, and that you are waiting for their questions. Do not
list the design problems you think you saw. The document is built so the reader
finds them.

## Completion criteria

Report completion only when all of these hold:

- The reader has the URL of a published revision.
- Every `error` diagnostic is resolved.
- The map is published, or you said why it is not - and the coverage split says
  the same thing the document does.
- The explainer is waiting on the reader, accepted, closed, dismissed or
  deleted.

Close with the decision and its summary (`wait.decision`) and the URL. When the
reader has not responded, say so and leave it open; a later session picks it up
from `thurview` in the same worktree.
