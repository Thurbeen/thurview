# Forges

`thurview pr-review` drives the same seam as `thurview forge`: `gh api` for
GitHub and `glab api` for GitLab, a self-hosted host owned by whichever CLI is
authenticated for it. The seam has no merge, close or push, so neither does
this command.

## What each forge does

| Step              | GitHub                                     | GitLab                                              |
| ----------------- | ------------------------------------------ | --------------------------------------------------- |
| The summary       | one issue comment, `PATCH`ed in place      | one merge request note, `PUT` in place              |
| A finding         | one review comment, a resolvable thread    | one diff discussion, a resolvable thread            |
| A line range      | anchored as the range                      | anchored at its last line                           |
| A suggestion      | ` ```suggestion ` over the range           | ` ```suggestion:-N+0 ` reaching back over the range |
| Resolving a fixed | a reply, then `resolveReviewThread`        | a reply, then `PUT .../discussions/<id>` resolved   |
| The stop label    | `thurview:stop` among the pull's labels    | `thurview:stop` among the merge request's labels    |
| The stop command  | an issue comment starting `/thurview stop` | a top-level note starting `/thurview stop`          |
| Merged or closed  | `merged`, or `state: closed`               | `state: merged` or `closed`                         |

## Where the state lives

The summary carries
`<!-- thurview-pr-review {"head":"<sha>","state":"active","seen":"<note id>"} -->`
and each finding's first comment
`<!-- thurview-finding {"id":"<id>","category":"bug","severity":"blocking"} -->`.
`state` is `active`, `stopped`, `merged` or `closed`. `seen` is the newest
note already read, so a `/thurview stop` posted before a `start` stops nothing.
Only a summary posted by the account the CLI is logged in as counts, so a
pasted marker changes nothing. A finding's id is the `id` given in the pass, or a hash of its category, path
and title, which is how the same finding found on the next push is recognised.

## Gaps

- No forge approve. A forge approve can arm an auto-merge, and the verdict
  lives in the summary; `thurview forge submit` is the command for one.
- GitHub reads the newest 100 review threads (`reviewThreads(last:100)`), the
  same limit `thurview forge prior` has; GitLab reads every page.
- Every call asks the forge who it is (`gh api user`, `glab api user`) to
  tell its own markers from pasted ones, so it needs a token that can read its
  own user; a GitHub App installation token cannot.
- A finding must sit on a line the diff touches. A finding on an untouched
  caller goes in a risk bullet.
- GitLab reports no per-thread staleness, and its adapter is driven by stub
  tests but has not been run against a live instance.
- The CLI sync accepts `reviewUrl` and `markdownUrl` without publishing them.
  The `thurview-pr-review` workflow performs the preflight, publish and link
  checks before calling sync, on either forge.
