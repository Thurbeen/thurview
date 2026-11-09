# Contributing

## Setup

```sh
pnpm install
pnpm build
npm link            # `thurview` on PATH, pointing at this checkout
prek install        # git hooks: commit message, format, types, tests, shell, markdown
```

Tools the hooks and the gate expect on PATH: `cog` (cocogitto), `prek`,
`shellcheck`, `rumdl`, `bats`.

```sh
pnpm dev -- pr-review status --change <n>    # run the CLI from source
```

Set `THURVIEW_HOME` to keep state elsewhere than `~/.thurview`.

## Commits and pull requests

Commits follow the conventional-commit spec as configured in `cog.toml`; the
scopes are listed there. Pull requests squash-merge into `main`, so the PR
title is the commit that lands and the `PR Title` check validates it. History
on `main` is linear; merge commits and rebase merges are disabled.

Before pushing, run `pnpm check`: the type-check, format check and end-to-end
suite CI runs, plus `rumdl check .`, `shellcheck` on the scripts and
`bats scripts/ci/*.bats`.

## Layout

- `README.md`: the introduction, install, use and CLI table;
  `docs/INSTALL.md` the other install routes.
- `src/cli.ts`: the AXI command surface; `src/flags.ts` the flag parser.
- `src/forge/`: the forge seam - one interface, a GitHub adapter driving `gh`
  and a GitLab adapter driving `glab`.
- `src/pr-review/`: `thurview pr-review` - the summary and finding markers,
  the closed category set, and the follow loop, all on the forge seam.
- `skills/thurview-pr-review/`: the one skill. `SKILL.md` is the review flow;
  `references/` holds the forge differences, the architecture lens every
  review leads with, and the search recipes.
- `test/pr-review.test.ts`: the summary, markers and follow loop against an
  in-memory forge.
- `test/pr-review-forge.test.ts`: the CLI end to end with a fake `gh` and
  `glab` on PATH (`test/fake-forge.mjs`), so both forge adapters are driven
  rather than asserted. Its summary goldens are under
  `test/fixtures/pr-summary/`.

## The skills and the command

`skills/` holds one skill, `thurview-pr-review`, which reviews an opened
PR/MR on the forge and follows it until merge. It is installed three ways,
and only one of them keeps the skill and the command in step:

| Route                                                        | Tracks                    |
| ------------------------------------------------------------ | ------------------------- |
| `skills@latest add .../thurview --skill thurview-pr-review`  | `main`, whatever it holds |
| `skills@latest add .../tree/<tag>/skills/thurview-pr-review` | that release              |
| `thurview setup skill`                                       | the installed command     |

Both `skills` routes take `--agent universal claude-code --global --yes`, as the
README and `docs/INSTALL.md` show: one real copy in `~/.agents/skills`, symlinked into each other
agent. `test/install-docs.test.ts` holds both files' commands to that form.

The skills CLI has no notion of a skill version: its lock file records a hash
of the folder's contents, plus the `ref` when one was given. So a change here
that depends on a new command, flag or output field is only safe once that
change is released, and the skill tells the agent to run `thurview update` and
retry when the command answers `unknown flag`.

## Releases

`cd.yml` runs on every push to `main`. cocogitto decides from the commits
whether a version is due, tags it, publishes to npm with provenance and writes
the GitHub release. A version is cut only when a shipped file changed since
the last tag (`src`, `bin`, `skills`, `package.json`, the lockfile); a
`workflow_dispatch` with an explicit version skips that gate. There is no
CHANGELOG file in the tree.

npm publishing runs on trusted publishing: npmjs.com knows this repository
and `.github/workflows/cd.yml` as the package's publisher, and the workflow's
`id-token: write` permission is what it exchanges for a short-lived
credential. Nothing is stored, and there is no switch to turn on. npm matches
the workflow by its **filename** (`cd.yml`), not its path or its `name:`, and
a mismatch fails the publish with `OIDC permission denied for this action`.

The job publishes before it tags, deliberately. Tagging first leaves a tag
behind whenever npm refuses, and since `cog bump --auto` reads the last tag it
then sees no releasable commits and never retries, so the version is lost
until the tag is deleted by hand.

`provenance` lives on the CI flag rather than in `package.json`, because a
publish run by hand has no attestation environment and would fail with it set.
`scripts/npm-publish.sh` covers that case: it publishes the latest tag's
version, refusing when shipped files have moved since, and restores
`package.json` afterwards.
