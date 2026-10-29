# thurview

**Your coding agent writes the review; you read it in the browser, anchored to
the code, and approve it or send it back.**

Every claim links to an exact file and line range at a pinned commit, and
`publish` refuses evidence that does not hold there. You ask in the document,
the agent answers in the same thread, and callers and tests the diff cannot
show are found by `git grep` searches you can run again.

Every review leads with the architecture: whether the change puts its logic
where it belongs, and whether its fixes remove a cause or patch a symptom with
another `if`. A design defect comes with its target shape and the next step
toward it, ahead of the bugs it causes.

[![CI](https://github.com/Thurbeen/thurview/actions/workflows/ci.yml/badge.svg)](https://github.com/Thurbeen/thurview/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/thurview)](https://www.npmjs.com/package/thurview)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

![thurview demo: the reader follows an anchor into the code, comments on a line
range in the diff, reads the agent's answer and requests changes](./media/thurview-demo.gif)

_The reader's half of it; the agent is working off camera._

## Install

Every skill, through the [skills](https://github.com/vercel-labs/skills) CLI,
for Claude Code, Codex, Cursor, OpenCode or any agent that reads the Agent
Skills format:

```sh
npx skills@latest add https://github.com/Thurbeen/thurview \
  --skill '*' --agent universal claude-code --global --yes
```

You need Node 22 or later and git, plus `gh` for pull requests or `glab` for
merge requests. Pinning a release, installing the command from npm, session
hooks and upgrading an older install are in [docs/INSTALL.md](docs/INSTALL.md).

## Quick start

In any repository, ask your agent:

```text
Use the thurview skill to review my current branch against up-to-date main
and open it.
```

For an opened PR or MR, ask `Use thurview-pr-review to review <URL>`: it
checks the cloud setup, seals a pinned review, publishes a public HTML snapshot,
and keeps one linked summary on the change request up to date on every push.
Each pass also sets a `thurview/review` status on the head it reviewed, which a
repository can [require before merge](skills/thurview-pr-review/references/forges.md#requiring-the-review).
It never starts a local server or waits for live page feedback. Where a page
may not be published, add "without a page": the same summary and threads go
on the forge, with no link and nothing published.

![How a review runs. The agent pins the change to exact commits, writes the walkthrough with every claim anchored to a line range, and publishes it, which checks every anchor and seals a revision. You read it in the browser, ask questions the agent answers in the same thread, and decide: approved or closed ends it, and requesting changes sends it back to the agent to fix, re-pin and publish again. For an opened PR or MR, thurview-pr-review checks the publishing setup, reviews the whole change and then what each push moved, seals the page, deploys a public snapshot, edits one linked summary and waits for the next push, until the change request is merged, closed or stopped.](./media/process.svg)

What the reader gets (the walkthrough, the diff, the map, threads, the
decision, and the queue on the home page) is in [docs/READER.md](docs/READER.md).

## Skills

| Skill                                                      | For                                                                                                         |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [`thurview`](skills/thurview/SKILL.md)                     | A local change already written: a branch or commit range. Approve or send back.                             |
| [`thurview-explain`](skills/thurview-explain/SKILL.md)     | A codebase or subsystem at one commit, with what it did not examine.                                        |
| [`thurview-design`](skills/thurview-design/SKILL.md)       | A change not written yet, its proposals anchored to the code they land in.                                  |
| [`thurview-fix`](skills/thurview-fix/SKILL.md)             | Review, commit the fixes that pass your tests and lint, report the rest. No browser.                        |
| [`thurview-pr-review`](skills/thurview-pr-review/SKILL.md) | An opened PR or MR: a review page, a public snapshot and one summary on the forge, followed until merge.    |
| [`thurview-publish`](skills/thurview-publish/SKILL.md)     | Put a document in your own Azure, S3, Cloud Storage or Cloudflare Pages account behind a link that expires. |

## Declaring what is in scope

By default every path in the repository is readable at the pinned commits: each
content route takes a path and reads it, and nothing enumerates what is
reviewable. A repository can invert that with `thurview-scope.yaml` at its root.

```yaml
# thurview-scope.yaml - what a thurview document may read from this repository
extensions: [ts, tsx, md, css] # allowed extensions, with or without the dot
filenames: [Dockerfile, Makefile] # allowed whole names, for the extensionless
exclude: # directories or globs, matched from the first segment
  - secrets
  - app/src/generated
  - "*/test" # the test directory of every top-level module
```

A path is readable when its extension or its whole name is listed **and** no
`exclude` entry is a prefix of it. Three things about those rules:

- **It is an allowlist, not an ignore list.** An ignore list covers the file
  types somebody remembered; an allowlist makes `.env`, `.jks`, `.keystore`,
  `.p12` and `google-services.json` fail by absence. Declare at least one
  extension or file name, or `publish` refuses the file rather than hiding the
  whole repository.
- **`filenames` is a list of its own,** because thurview is language-agnostic:
  `Dockerfile`, `Makefile`, `Jenkinsfile` and a dotfile whose entire name is its
  suffix have no extension to allow.
- **`exclude` matches from the first segment,** so `app/src/test` excludes that
  directory and leaves `lib/app/src/test` alone. An entry may be a glob, and it
  is anchored the same way: `*` is exactly one segment, so `*/test` excludes
  `module-a/test` and every other top-level module's `test`, and leaves
  `a/b/test` alone; `**` is zero or more segments, so `**/test` excludes a `test`
  directory at any depth, the root one included. `?` matches one character
  within a segment. There are no character classes: `[` and `]` are refused, so
  a route directory such as `app/[id]` is an error rather than a class that
  leaves it open. An entry without `*` or `?` is a plain path and matches
  exactly what it did before globs were read.
- **An entry that cannot match is refused where it is written.** `*.ts` or
  `tar.gz` under `extensions`, a path under `filenames`, a glob under `exclude`
  that cannot be read - a bracket, `***`, an empty segment, or one such as `**`
  or `?*` that would exclude everything: each is an error, not a rule that quietly
  matches nothing. And because a wrong `exclude` entry is the one mistake here
  that _opens_ a path rather than closing it, `publish` warns when one matches
  nothing at the pinned commit, glob or not - `Secrets` withholds nothing where
  `secrets` withholds a tree, and so does `*/tests` where the modules say
  `test`.
- **A rename is shown only when both its sides are readable.** The diff of
  `secrets/token.ts -> src/token.ts` is the content of the excluded side, so the
  change is withheld whole and counted as withheld, rather than listed as a file
  whose diff is then refused.

The rules apply in both places a document is read from, because they are fed
from different places. At `publish`: a peek at an excluded file is an error, and
the sealed revision's file list, its map's file lists and an explainer's
coverage listing hold nothing excluded. At
serving: the diff, the file, the symbol index and each commit's
path list are read from git per request, and each refuses an excluded path with
**"excluded by scope"** - not a 404, which would claim the file is not there.
A glob is applied in both, through the same matcher.
HTML export applies the same rules to diffs, file contents and commit file lists,
including files a thread points at. A thread's text and target remain as written.

`thurview-scope.yaml` itself is always readable, so a reader can read the rule
that withheld a file. A revision is served back exactly as it was sealed, so each
one records the rules it was sealed under, in full. Widening them later costs
nothing: a revision holds only what the rules in force when it was sealed let in,
so if all of that is still allowed it stays readable. Narrowing them is what the
record is for - the older revisions are refused with the same words until
`thurview publish` seals one under the rules in force, and that is the deliberate
price of not serving what the rules now withhold. `scaffold`, `explain`, `design`
and `publish` print the rules and how many changed files they withheld, and the
Files tab says so above the list; the count a reader sees is the one the revision
they are reading was sealed with, so it describes that file list and not whatever
the pins have moved on to.

An explainer's recorded search lists omit excluded files. Search patterns,
pathspecs and reasons are author-written text; the search's hit count still
counts all matches, as it does for a search outside the explainer's path scope.

Two things the scope does **not** decide, and neither should be read into it:

- **Commit messages.** `thurview-scope.yaml` is about paths. The per-commit file
  list on the Commits tab is filtered; the subject, the body and the author are
  served as git holds them.
- **Writes.** A reader's comment and their verdict are their own words, posted
  as typed. The scope bounds what can be read, not what can be written or sent
  to a forge. A comment records the path its author pointed at, and it is served
  back as they wrote it.

And one thing about what kind of control it is: the rules live in the repository
under review and are read at the pinned head commit, so **the change request
being reviewed can edit them.** That edit is visible in the diff, which beats
invisible, but it makes this a control against putting the wrong file in front
of a reviewer by accident - not a boundary that holds against an author who does
not want it to.

## CLI

| Command                                                     | Purpose                                                           |
| ----------------------------------------------------------- | ----------------------------------------------------------------- |
| `thurview scaffold [--pr N \| --base R --head R]`           | Create a review pinned to exact commits (`--update` re-pins)      |
| `thurview explain [<path>] [--commit R]`                    | Create an explainer of a codebase or subsystem at one commit      |
| `thurview design [<path>] [--commit R]`                     | Create a design, pinned to the commit it argues from              |
| `thurview info [--all]`                                     | Documents bound to this worktree                                  |
| `thurview publish [--review ID] [--pass F] [--open]`        | Validate the document and map, seal a revision and its verdict    |
| `thurview open [--review ID] [--view T]`                    | Start the server if needed and open the browser                   |
| `thurview wait [--review ID] [--timeout S]`                 | Block until the reader needs the agent                            |
| `thurview threads list\|get\|reply\|resolve`                | Read and answer threads                                           |
| `thurview export [<id>] [--out PATH]`                       | Write the published revision as one HTML file                     |
| `thurview publish-static --check --to cloudflare`           | Check the Cloudflare target, login and project, uploading nothing |
| `thurview publish-static <id> --out DIR \| --to cloudflare` | Render a read-only snapshot, or deploy it to Cloudflare           |
| `thurview forge status\|prior\|pass\|submit\|reply`         | Read a change request, and post a review back to it               |
| `thurview pr-review status\|sync\|wait\|stop\|start`        | Follow a change request until it merges                           |
| `thurview delete --review ID`                               | Delete a document and what is stored for it                       |
| `thurview serve` / `thurview stop`                          | Run the server in the foreground / stop the background one        |
| `thurview setup hooks\|skill\|status`                       | Session hooks, agent skills, install state                        |
| `thurview update`                                           | Self-update from npm                                              |

thurview is an [AXI](https://axi.md): output is [TOON](https://toonformat.dev),
errors carry a `help` to act on, and `thurview` with no arguments shows the
current directory's state. `thurview <command> --help` lists every flag.

## Configuration

Everything lives under `~/.thurview` (or `$THURVIEW_HOME`) and runs against
your checkout; the server listens on loopback and, when present, your
Tailscale address.

- **Agent guidance**: `~/.thurview/THURVIEW.md` for you, `THURVIEW.md` at a
  repository root for that repository.
- **Cloudflare snapshots**: `~/.thurview/cloudflare.json`; see
  [setup](skills/thurview-pr-review/references/cloudflare-setup.md) and
  [public static snapshots](skills/thurview/references/lifecycle.md#public-static-snapshots).
- **Your own cloud**: credentials, permissions and link expiry per provider are in
  [thurview-publish](skills/thurview-publish/SKILL.md).

## Documentation

- [docs/READER.md](docs/READER.md): every tab, threads, the decision, sharing.
- [docs/INSTALL.md](docs/INSTALL.md): other install routes and upgrades.
- The document format: [authoring](skills/thurview/references/document-authoring.md),
  [components](skills/thurview/references/components.md),
  [software map](skills/thurview/references/software-map.md),
  [lifecycle](skills/thurview/references/lifecycle.md).
- Forges: [commands and differences](skills/thurview-fix/references/forges.md).

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) covers the hooks, the gate, commits and releases.

```sh
pnpm install && pnpm build && pnpm check
```

## License

MIT, see [LICENSE](LICENSE).
