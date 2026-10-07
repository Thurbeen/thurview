# Forges

`thurview forge` speaks to GitHub through `gh` and to GitLab through `glab`.
Both are driven through `gh api` and `glab api` rather than their porcelain,
because the REST and GraphQL payloads are a contract and the porcelain is not.

Which adapter owns a host is decided by name for `github.com` and
`gitlab.com`, and read off the machine for everything else - a host is owned
when `gh auth status --hostname <host>` or `glab auth status --hostname
<host>` succeeds, which is where the answer for a self-hosted instance already
lives. `GH_HOST` and `GITLAB_HOST` are honoured. A host no adapter claims is
**refused**, not guessed at; pass `--forge github|gitlab` to name it.

## The commands

```sh
thurview forge status --change 123    # what CI actually did, and whether it is a gate at all
thurview forge prior  --change 123    # the previous pass, thread by thread
thurview forge pass   --review <id>   # the reader's submitted threads, as the file below takes
thurview forge submit --change 123 --file pass.json --dry-run
thurview forge reply <threadId> --change 123 --body "<answer>" --resolve --at <head>
```

`status` counts passed, failed, cancelled, skipped and running checks
separately, and compares them against what the target branch's own tip runs -
a change request from a fork typically runs a fraction of them, and a
cancelled job shows no failure while asserting nothing. `ci.trustworthy` is
the only field that means the tests really passed.

`pass` turns a review a reader submitted in the browser into the file `submit`
takes; [lifecycle.md](../../thurview/references/lifecycle.md#carrying-a-submitted-review-to-the-change-request)
has its rules.

`submit` takes one JSON file so a human can read the pass before it is posted,
refuses an `approve` without `--confirm`, and warns about comments too long to
be read. `reply --resolve` takes `--at <sha>` and refuses any commit but the
current head, so a thread is never closed against code nobody looked at. There
is no merge, close or push command, deliberately.

## What differs, and what the CLI does about it

| Behaviour              | GitHub                                    | GitLab                                                                                      |
| ---------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------- |
| The noun               | pull request                              | merge request                                                                               |
| A pass                 | one atomic review                         | N discussions plus one note; no atomic form exists                                          |
| Requesting changes     | `CHANGES_REQUESTED`, which blocks a merge | no such state; the account's approval is removed and the summary says it                    |
| A comment's anchor     | a line range, `start_line` to `line`      | one line; a range is anchored at its last line and `notes` says so                          |
| Thread identity        | a GraphQL node id                         | a discussion id                                                                             |
| Resolving              | `resolveReviewThread`                     | `PUT .../discussions/<id>?resolved=true`                                                    |
| Staleness of a thread  | `isOutdated` from the forge               | not reported; compare `threads[].atHead` against the current head instead                   |
| CI                     | check runs plus commit statuses           | the latest pipeline's jobs, read from the pipeline's own project so a fork's jobs are found |
| Fetching a head        | `refs/pull/<n>/head`                      | `refs/merge-requests/<n>/head`                                                              |
| A line range permalink | `#L10-L20`                                | `#L10-20`                                                                                   |

Consequences worth knowing before you post:

- On GitLab a pass that fails half way through has already posted the
  comments it got to. The inline comments go first and the summary last, so a
  partial pass is still one the author can read, but check `submitted.comments`
  against what you sent.
- `request-changes` on GitLab does not block a merge. If blocking matters,
  say so in the summary and leave it to the maintainer.
- A multi-line finding on GitLab loses its range. Put the range in the
  comment's own permalink.

## What has been exercised

The GitHub adapter is driven by tests and against github.com. The GitLab
adapter is driven by the same tests - the calls it makes and the answers it
parses are asserted - but has not been run against a live GitLab instance. If
you are the first to point it at one, expect the friction to be in `glab api`'s
own flags rather than in the endpoints, and report what differed.

## Adding a forge

Implement `Forge` in `src/forge/types.ts` and register it in `BUILTIN` in
`src/forge/index.ts`. The interface is the whole contract - `get`, `fetchRef`,
`checks`, `baseline`, `prior`, `submit`, `reply`, `permalink`, plus `owns` and
`whoami`. There is deliberately no `merge`, `close` or `push`.

Then drive it from `test/forge.test.ts`. The tests put a fake CLI on PATH
under the adapter's own binary name and answer from a fixture table, so an
adapter is proved by the calls it makes and the answers it parses rather than
by being asserted to exist.
