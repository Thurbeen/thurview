---
name: thurview
description: Author and publish a thurview review - a guided, evidence-anchored explanation of a branch, pull request or commit range that the reader opens in the browser, annotates, asks questions about, and approves or sends back. Use when the user asks to review a branch or PR, to explain or walk through a change, "review my branch against main", to explain how a codebase or subsystem works, or invokes /thurview. Not for a pass/fail bug hunt.
user-invocable: true
argument-hint: "[<pr-number|pr-url> | --base <ref> --head <ref> | <architecture topic>]"
---

# thurview

The agent studies the change and writes a short document in which every claim
about code is anchored to an exact file and line range at a pinned commit.
thurview validates those anchors, seals a revision, and serves it in the
browser with live code peeks, diffs, diagrams and a map. The reader asks
questions, leaves anchored comments, and approves or requests changes. The
agent answers, updates, republishes.

```mermaid
flowchart LR
  A[scaffold: pin base and head] --> B[author review.md, data.yaml, map.yaml]
  B --> C[publish: validate and seal revision]
  C --> D[open: reader reviews in the browser]
  D -->|question| E[threads reply]
  E --> D
  D -->|request changes| B
  D -->|approve| F[done]
```

Run the CLI as `thurview`. When it is not on PATH, `npx -y thurview` runs
the published package with the same commands; substitute it everywhere below.
If a command answers `unknown command` or `unknown flag` for something this
skill tells you to run, the installed CLI is older than the skill: run
`thurview update` and retry once, then report the mismatch if it persists.

Every command prints TOON on stdout: the result, then `help[]` with the next
commands. Errors are structured on stdout too (`error`, `code`, `help`); exit
code 1 is a failure, 2 a usage error such as an unknown flag. Progress goes to
stderr; do not scrape it. `thurview` alone shows the reviews of the current
directory; `thurview <command> --help` shows flags and examples.

## Request

$ARGUMENTS

Empty: the current branch against its up-to-date trunk. A PR number or URL:
that pull request. `--base`/`--head`: that range. Anything else: an
architecture review of that topic in the current repository.

## Before authoring

Read the guidance files that exist, in this order. The second wins on
conflict.

1. `~/.thurview/THURVIEW.md` (or `$THURVIEW_HOME/THURVIEW.md`), user guidance.
2. `THURVIEW.md` at the repository root, repository guidance.

`thurview scaffold` lists the ones it found under `guidance`.

Read [Document authoring](references/document-authoring.md) before you write.
Read [Components](references/components.md) before you edit `data.yaml` or add
a fenced component. Read [Lifecycle](references/lifecycle.md) for statuses,
storage and thread rules. Read [Software map](references/software-map.md)
before you author `map.yaml`. Read [Theme](references/theme.md) before you
write `theme.yaml`.

## Workflow

### 1. Pin the change

Run `thurview scaffold` in the source worktree with the flags that match the
request:

```sh
thurview scaffold                          # current branch vs its trunk fork point
thurview scaffold --pr 123                 # pull request (needs gh)
thurview scaffold --base <ref> --head <ref>
```

An active review bound to the same branch, pull request or range is reused
and re-pinned (`review.reused` is true), so a second run for the same request
continues the same review; pass `--new` for a separate one. After the branch
moves, `thurview scaffold --update --review <id>` re-pins. `thurview info`
lists the reviews bound to the worktree, with `inSync` (HEAD equals the pinned
head), when you need to choose between several.

Record from the output: `review.id` (the short id, accepted everywhere),
`review.dir`, `review.base`, `review.head`, `files.document`, `files.data`,
`files.map`, `files.theme`, `change` (files, additions, deletions) and
`guidance`.

Resolve refs before passing them. Pass commit ids or plain ref names; do not
pass `<rev>^` inside a jj workspace.

### 2. Let the reader start on a small change

When `change.additions + change.deletions` is under 300, publish the stub now
and land the reader on the diff:

```sh
thurview publish --review <id> --view files --open
```

The stub tells the reader the walkthrough is on its way, so they read the diff
while you write it, and the page offers the next revision as soon as you
publish again. Skip this for larger changes: a diff that size is not readable
cold, and the walkthrough is what makes it so.

### 3. Study the change

Read the whole diff once (`git diff <base> <head>`). The diff tells you what
changed. The code graph tells you what it means, which is what the review is
for. thurview builds it from the pinned commits with tree-sitter and the
definitions-and-references query each grammar ships, so ask it rather than
re-deriving structure from hunks:

```sh
thurview graph impact --review <id>             # symbols touched, edges added and removed, what reaches them, what tests cover them
thurview graph callers <symbol> --review <id>   # used, or speculative? (--graph base for the old side)
thurview graph tests-for <symbol> --review <id>
thurview graph architecture --review <id>       # file clusters with their hubs, the edges between them, the file-level diff
```

The graph covers TypeScript, JavaScript, Python, Go, Rust and Java; other
files are absent from it, not empty. References resolve by name, so treat
`unresolved` as the size of what it could not place, and `<module>` as code
outside any definition. If `truncated` is true (`truncated.base` and
`truncated.head` for impact and architecture, which look at both commits; a
plain `truncated` for callers and tests-for, which look at one), the repo has
more supported files than the graph could parse, and that answer is a partial
view: say so rather than treating an empty result as "nothing there".

Spend the review on what those answer: what the change reaches that the diff
does not show, which boundaries it crosses, what now depends on what, what it
left untested. Then compare the stated intent (commit messages, PR
description, the user's own words) with what the code does. The gap is the
most valuable finding.

Do not spend the review on naming, formatting, import order, or missing
defensive checks. Linters, type checkers and `/code-review` catch those, and a
reader who wanted them would have run those instead.

Read every range you anchor from the pinned commit, not the working tree:
`git show <head>:<path>` or `git show <base>:<path>`.

### 4. Start the map

Dispatch one sub-agent to write `map.yaml` per
[Software map](references/software-map.md) now, so it works while you write
the document, with this prompt filled in:

```text
Use the thurview skill's software-map reference (`thurview skill` prints the
SKILL.md path; the reference is in references/software-map.md beside it).

Review directory: <dir>
Source worktree: <worktree>
Base commit: <base>
Head commit: <head>

Seed the structure from `thurview graph architecture --review <id>` rather
than guessing it: communities and their hubs become nodes, its edges the
edges, and its diff the difference between base and head.

Author <dir>/map.yaml: the head structure under nodes/edges and the base
structure under base. Do not edit review.md or data.yaml. Do not publish.
Return when `thurview publish --review <id>` reports no map.yaml errors, or
report the errors you could not fix.
```

Without a sub-agent facility, write the map yourself after the document, or
leave `nodes: []` and say the map is not published.

### 5. Author the document

Edit `review.md` and `data.yaml` in the review directory following
[Document authoring](references/document-authoring.md). Keep it short.
Default to anchor links for evidence; use an inline peek only when the reader
must see the code to follow the main claim.

### 6. Theme the review after the project

Read [Theme](references/theme.md). Decide the look in its order: what the
user asked for, then the reviewed project's own design system read from its
files at head, then the default skin. Write `theme.yaml` in the review
directory when steps 1 or 2 yield tokens; leave it empty otherwise.

### 7. Publish

```sh
thurview publish --review <id>
```

Read every row of `diagnostics`. Fix each `error` and publish again. A
`warning` does not block. `publish` refuses (code `THREADS_OPEN`) when a
submitted comment thread is still open (see step 10). On success `published`
carries `rev` and `url`; the status becomes `awaiting-review`.

Then open it for the reader, unless step 2 already did:

```sh
thurview open --review <id>            # prints url; --view files|commits|map
```

### 8. Hand over

Tell the user, in a few lines and nothing more:

- the `url`
- what the review covers, in one sentence, and where to start: the Review tab
  as a rule; the Files tab when the change is small and the diff is the story
- which theme source you used: the user's request, the project's design
  system (name the files), or the default skin
- that you are now waiting for their questions and their decision

The page explains its own controls; do not describe them.

### 9. Wait for the reader

```sh
thurview wait --review <id> --timeout <seconds>
```

It blocks until the reader needs you or `--timeout` seconds pass (default
3600). Your shell tool has a limit of its own, and a command it kills prints
nothing: keep `--timeout` under that limit and run `wait` again on `timeout`.
When the tool can run a command in the background and wake you when it exits,
run `wait` that way, so the user has the terminal back while they read.

`wait.reason` says what happened, with the threads that need you:

- `question`: an "Ask now" thread. Answer each thread in `threads` with
  `thurview threads reply <threadId> --review <id> --body "<answer>"`. Do
  not change the document for a question. Wait again.
- `awaiting-agent-updates`: the reader submitted with "Request changes".
  `threads` lists what to address and `wait.decision` the summary. Go to
  step 10.
- `accepted`: approved. Report and stop.
- `closed`: the reader ended the review without approving it. Report and stop.
- `review-dismissed` or `review-deleted`: stop.
- `timeout`: nothing happened. Wait again, or tell the user the reader has not
  responded and stop.

### 10. Address requested changes

For each thread in `thurview threads list --review <id> --open`:

- A document problem: fix `review.md` or `data.yaml`.
- A code change request: change the branch under the normal rules (failing
  test first), then `thurview scaffold --update --review <id>` to re-pin, and
  re-read every anchored range that moved.
- Answer in the thread with `threads reply` when the reader asked something
  or when it is not obvious what you changed.
- `thurview threads resolve <threadId> --review <id>` once the requested
  change is present. Do not resolve a thread you did not address.

Then publish again (step 7), tell the user what changed since the previous
revision in a line or two, and wait again (step 9). A republish requires zero
open submitted comment threads; questions do not block.

## Architecture reviews

Pin the same commit as base and head: `thurview scaffold --base HEAD --head
HEAD`. Choose sections that describe the system (data flows, state, storage,
module boundaries) and skip diff-specific ones. Scope to one subsystem. All
other steps are the same; the Files tab shows any file at head on request.

## Completion criteria

Report completion only when all of these hold:

- The reader has the URL of a published revision.
- Every `error` diagnostic is resolved.
- The map is published, or you said why it is not.
- The review is waiting on the reader, accepted, closed, dismissed or deleted.

Close with the decision and its summary (`wait.decision`), and the URL. When
the reader has not responded, say so and leave the review open; a later
session picks it up from `thurview` in the same worktree.
