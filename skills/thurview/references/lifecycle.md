# Lifecycle and storage

## Binding and pins

A review binds to one unit of change: a branch, a pull request, or an
explicit range. Scaffold resolves and records exact base and head commit
ids. Everything is read from those commits, so moving the checkout changes
nothing the reader sees.

Choose the base deliberately:

- bare scaffold: the trunk fork point (`merge-base` with `origin/HEAD`)
- one commit: `--base <head>~1 --head <head>`
- a stack: the branch directly below it

`thurview scaffold --update --review <id>` re-pins from the binding: a branch
follows its local tip, a PR asks GitHub. Publication never moves pins; it
warns when the branch moved past them.

## Statuses

| Status                   | Owner and next action                                    |
| ------------------------ | -------------------------------------------------------- |
| `draft`                  | Agent authors and publishes.                             |
| `awaiting-review`        | Reader reads, asks, comments, decides.                   |
| `awaiting-agent-updates` | Agent addresses threads, resolves them, republishes.     |
| `accepted`               | Terminal. Cannot be republished.                         |
| `closed`                 | Terminal. Ended without approval. Cannot be republished. |

Asking the agent a question does not change the status. "Submit review" with "Request changes"
sets `awaiting-agent-updates`; with "Approve" sets `accepted`; with "Close"
sets `closed`.

Dismissal is separate: the reader removes the review from the active list and
`wait` returns `review-dismissed`. A new publication restores it.

## Threads

Two kinds, chosen by the reader when creating one. In the browser these are
the two buttons on the comment box, one click each:

- `ask` mode (a question, "Send to the agent"): submitted on creation and
  delivered at once. `wait` returns `question`. Answer with `threads reply`.
  Open questions never block a republish.
- `review` mode (a comment, "Add to the review"): held as pending until the
  reader submits. Then `wait` returns `awaiting-agent-updates` with the
  submitted threads.

Targets: a document block (with an optional quoted selection), a file line
on the base or head side, a map node, or the whole review.

### Status, `submitted` and `needsAgent`

Two flags and one derived predicate decide whether a thread reaches you.
`needsAgent` is the whole queue: `wait` reports it, `threads list --open`
counts it, and a thread outside it will not be delivered to anyone.

```text
needsAgent = status is open  AND  submitted  AND  the last message is the reader's
```

| Transition                     | status               | submitted     |
| ------------------------------ | -------------------- | ------------- |
| reader creates an `ask` thread | `open`               | `true`        |
| reader creates a `review` one  | `open`               | `false`       |
| reader submits the review      | unchanged            | `true` (all)  |
| **reader writes in a thread**  | **forced to `open`** | `true` if ask |
| agent replies                  | unchanged            | unchanged     |
| `threads resolve` / Resolve    | `resolved`           | unchanged     |
| Reopen                         | `open`               | unchanged     |

A message from the reader always reopens the thread. It has to: a reply that
left the thread resolved would sit at `needsAgent: false`, invisible to
`wait` and to `threads list --open`, and the reader would be writing to
nobody while the page still offered them a Reply button. Publishing a new
revision never touches a thread's status.

`publish` after the first revision requires zero open submitted comment
threads. Resolve a thread only when its requested change is present. Do not
rewrite or merge threads.

### Presence: what the reader is told

While `thurview wait` runs it writes a heartbeat to
`${THURVIEW_HOME:-~/.thurview}/agents/<reviewId>.json`, and the browser reads
it back as one of two sentences: an agent is listening now, or nothing is
listening and what you send is queued until one checks in. Nothing else
writes it, so presence is never inferred and never faked. A heartbeat older
than 15 seconds is a dead `wait`, not an agent.

That is why a question asked while you are away is not lost and does not need
you to sit in `wait`: it is queued, `thurview` reports it as `needsAgent` the
next time you run any command in the worktree, and you answer it then.

```sh
thurview threads list --review <id> [--open]
thurview threads get <threadId> --review <id>
thurview threads reply <threadId> --review <id> --body "<text>"
thurview threads resolve <threadId> --review <id>
```

## Storage

```text
${THURVIEW_HOME:-~/.thurview}/
├── THURVIEW.md              user guidance (optional)
├── server.json              running server, if any
├── agents/<id>.json         heartbeat of a running `wait`, removed when it ends
└── reviews/<id>/
    ├── review.md            you edit
    ├── data.yaml            you edit
    ├── map.yaml             you edit
    ├── theme.yaml           you edit (project look; empty = default skin)
    ├── review.json          binding, pins, status, presented revision
    ├── threads.json         threads and decisions (use the CLI)
    └── revisions/<n>/       sealed copies plus compiled document.json, map.json
```

A failed publish leaves the last sealed revision in place. The reader can
switch between revisions in the browser.

## wait

`thurview wait --review <id> [--timeout <s>]` polls the review and returns
`wait.reason` in `question`, `awaiting-agent-updates`, `accepted`,
`closed`, `review-dismissed`, `review-deleted`, with the threads that need
you, or `timeout` once `--timeout` seconds (default 3600) pass with nothing
to report. A timeout is a result, not a failure: the command exits 0. Keep
the timeout under your shell tool's own limit, since a command the tool kills
prints nothing. A question already answered by the agent is not reported
again.

`thurview threads get <id>` truncates bodies over 1500 characters; pass
`--full` when the hint says so.

While `wait` runs, the reader's page says an agent is listening; when it
returns, the page says the opposite within seconds. Do not leave `wait`
running to look present when you are not going to answer, and do not loop it
to keep a queue drained: the queue survives you, and the reader is told so.
