# Forges

`thurview pr-review` drives `gh api` for GitHub and `glab api` for GitLab, a
self-hosted host owned by whichever CLI is authenticated for it. It has no
merge, close or push.

## What each forge does

| Step              | GitHub                                     | GitLab                                              |
| ----------------- | ------------------------------------------ | --------------------------------------------------- |
| A review starts   | the `eyes` reaction on the pull request    | the `eyes` award emoji on the merge request         |
| The summary       | one issue comment, `PATCH`ed in place      | one merge request note, `PUT` in place              |
| A finding         | one review comment, a resolvable thread    | one diff discussion, a resolvable thread            |
| A line range      | anchored as the range                      | anchored at its last line                           |
| A suggestion      | ` ```suggestion ` over the range           | ` ```suggestion:-N+0 ` reaching back over the range |
| A guard           | a folded `<details>` under the fix         | the same                                            |
| Resolving a fixed | a reply, then `resolveReviewThread`        | a reply, then `PUT .../discussions/<id>` resolved   |
| The stop label    | `thurview:stop` among the pull's labels    | `thurview:stop` among the merge request's labels    |
| The stop command  | an issue comment starting `/thurview stop` | a top-level note starting `/thurview stop`          |
| Merged or closed  | `merged`, or `state: closed`               | `state: merged` or `closed`                         |
| The review status | commit status `thurview/review`, `POST`ed  | commit status `thurview/review`, `failed` below 5   |

## What the summary looks like

The summary uses the same compact Markdown on both forges. It opens with the
next action and confidence on one line. Stop, resume, merge and close replace the
action while keeping the reviewed confidence score. Its two-column findings
table lists severity, category and title beside a `file:line` thread link,
blocking first. With zero findings it says `No open findings.` and omits the
table. Full finding detail stays in the inline thread.

A first pass says `First review`. An edited pass folds `Since this review`
with resolved, new and still-open counts from that pass; the CLI returns them
as `sinceLastReview` (`resolved`, `new`, `stillOpen`), not lifetime totals.
Change and risks are folded separately; the reviewed head and UTC sync
timestamp stay small below them. The sign-off is last. Both forges use
ordinary Markdown tables and HTML `details`/`summary`, with blank lines
around their Markdown.

GitHub links each location to its review comment; GitLab links to the
discussion's first note. A new finding gains its link from the forge's posting
response; a dry run has no new thread yet and shows the location without
inventing a URL. Older threads without a reported URL also show an unlinked
location.

## What `sync` does with a pass

- **Budgets.** The 120 words count the authored `reason`, `architecture`,
  `security`, `change`, `risk` and `signoff`, folded text included, before
  rendering, so Markdown or HTML cannot hide words. Generated rows, links,
  counts and notes in `others` are outside it, and so is a guard.
- **Assessments.** A `fixed` one gets a reply with the commit and the
  evidence, then its thread is resolved. A thread the author resolved still
  gets that first confirmation. A `partial` one gets a reply with what
  remains and stays open. A resolved thread whose finding is still present
  is flagged in the summary and counts against confidence.
- **Retries.** A failed resolution leaves the old summary intact, and a
  retry at the same head does not duplicate replies or findings.
- **After a merge or close.** `sync` accepts the head that was reviewed as
  long as the change request once had it as its head, and edits only the
  summary: no new thread, reply or resolution. The summary opens with
  `reviewed after the merge` (or `close`), never `Next: merge`, and says
  when the merged head is not the one reviewed.
- **Other reviewers.** An agreed thread is a row of the findings table,
  linked to their thread and credited; the rest are a second table with the
  note.

## Where the state lives

The summary carries
`<!-- thurview-pr-review {"head":"<sha>","state":"active","seen":"<note id>"} -->`
and each finding's first comment
`<!-- thurview-finding {"id":"<id>","category":"bug","severity":"blocking"} -->`.
`state` is `active`, `stopped`, `merged` or `closed`. `agreed`, when there,
lists the other reviewers' threads the last pass agreed with, so they stay
listed after a resolve until a pass says `fixed`. `seen` is the newest
note already read, so a `/thurview stop` posted before a `start` stops nothing.
Only a summary posted by the account the CLI is logged in as counts, so a
pasted marker changes nothing. A finding's id is the `id` given in the pass, or a hash of its category, path
and title, which is how the same finding found on the next push is recognised.

## Requiring the review

Every `sync` sets a commit status named `thurview/review` on the head it
reviewed. It is `success` at confidence 5 with no open finding, nits and
agreed threads of other reviewers included, or, under `--approve-at <n>` below
5, at confidence `n` or more with no blocking finding open; `failure` otherwise. Its
description is the score and the open count, and it links the change request.
A push leaves the
new head with no status until a pass reviews it. The status reports a
verdict; it approves and merges nothing.

**It records the verdict; it is not an access control.** `thurview` sets the
status with the reviewer's own login, a user or a GitHub App, and any account that can push
to the repository can set a status named `thurview/review` too, `success`
included. Requiring it stops a merge nobody reviewed by mistake: a hand merge
on a head no pass saw, or before the pass finished. It does not stop someone
with push access who means to get around it.

To make a merge wait for it, the repository's owner changes one setting. The
command never does:

- **GitHub:** Settings → Rules → Rulesets → the ruleset on the default branch →
  **Require status checks to pass** → add `thurview/review`. Classic branch
  protection takes it the same way. A head with no status yet waits, so a
  push cannot merge before a pass reviews it. A ruleset can pin a required
  check to the GitHub App expected to set it, and then refuses the same name
  from anyone else. A status set with a user's token cannot be pinned that
  way, so leave the source as any when a user runs the review.
- **GitLab:** Settings → Merge requests → **Pipelines must succeed**. The status
  joins the head's pipeline, so a `failed` review blocks the merge. This is
  weaker than on GitHub: a head with no status yet is not held back by it.
  GitLab does not pin a commit status to its author either, and any
  Developer can set one.

## Gaps

- The status is a commit status, not a check run: GitHub lets only an App
  create check runs, and `gh` is logged in as a user. A ruleset requires
  either the same way. Its description holds the score line, not the whole
  summary, and it links the change request.
- No forge approve unless the requester passed `sync --approve-at <n>`. A
  forge approve can arm an auto-merge, and the verdict lives in the summary.
  With it, `sync` approves only when the `thurview/review` status passes at
  that threshold (confidence `n` or more, nothing blocking open), after
  re-reading the head: an approval never sits beside a failing status. It
  never reads the head's CI checks or pipeline, so CI neither blocks nor
  grants an approval. GitHub gets an
  `APPROVE` review on the reviewed commit; it still counts for the pull
  request after a later push unless the repository dismisses stale approvals.
  GitLab gets an approval pinned by `sha`, which it refuses once the head
  moved, and carries no text. A pass that falls short withdraws this
  account's approvals: a dismissal on GitHub, `unapprove` on GitLab. An
  approval `sync` gave the reviewed head that was dismissed, by a maintainer or by an
  earlier withdrawal, is not given again at that head. Withdrawal happens only
  in a `sync` that carries `--approve-at`: a stopped review, or a push not yet
  reviewed, leaves the last approval standing. A
  refused approval or withdrawal is reported under `approval` and does not
  fail the pass.
- GitHub reads the newest 100 review threads (`reviewThreads(last:100)`) and
  the newest 100 reviews, which is where it finds its own approvals; GitLab
  reads every page.
- Every call asks the forge who it is (`gh api user`, `glab api user`) to
  tell its own markers from pasted ones. A GitHub App installation token
  cannot read its own user: when GitHub refuses the call with a 403 that is
  not a rate limit,
  `THURVIEW_LOGIN`
  names the account instead, as the App's `<app-slug>[bot]`. A token that
  can read its user keeps the login GitHub answers, whatever `THURVIEW_LOGIN`
  says. Only the caller sets `THURVIEW_LOGIN`; without it, a token GitHub
  refuses `GET /user` fails with `FORGE_ERROR`.
- A finding must sit on a line the diff touches. A defect confirmed in an
  untouched caller is anchored on the changed line that reaches it; it is
  still a finding, never only a risk bullet.
- GitLab reports no per-thread staleness, and its adapter is driven by stub
  tests but has not been run against a live instance.
