# Contributing

## Setup

```sh
pnpm install
pnpm build
npm link            # `thurview` on PATH, pointing at this checkout
prek install        # git hooks: commit message, format, types, tests, shell, markdown
```

Tools the hooks and the gate expect on PATH: `cog` (cocogitto), `prek`,
`shellcheck`, `rumdl`, `bats`, `chromium` for `scripts/browser-check.mjs`.

## Commits and pull requests

Commits follow the conventional-commit spec as configured in `cog.toml`; the
scopes are listed there. Pull requests squash-merge into `main`, so the PR
title is the commit that lands and the `PR Title` check validates it. History
on `main` is linear; merge commits and rebase merges are disabled.

Before pushing, gate the change with no-mistakes; `.no-mistakes.yaml` holds
the lint, format and test commands it runs and the review instructions per
path. `pnpm check` runs the same type-check, format check and end-to-end suite
locally.

## Layout

- `src/cli.ts`: the AXI command surface; `src/flags.ts` the flag parser.
- `src/document/`: schema, parser and compiler for `review.md` and
  `data.yaml`; `src/theme.ts` for `theme.yaml`.
- `src/server/`: the HTTP API, SSE and static UI.
- `src/ui/`: the browser app, vanilla TypeScript bundled by esbuild.
- `skills/thurview/`: the agent skill and its references, the single source
  for every authored file's shape.
- `test/e2e.test.ts`: the suite, driving the CLI and the server end to end.

## Demo media

`scripts/demo/record.sh` re-records `media/thurview-demo.{mp4,gif}` from
scratch: it builds the demo repository (`make-repo.sh`), publishes the review
under `scripts/demo/review/`, records the agent side with VHS
(`agent.tape.in`) and the reader side with a Chromium screencast
(`record-browser.mjs`), and joins both with ffmpeg. It needs `vhs`, `ttyd`,
`ffmpeg`, `chromium` and `thurview` on PATH, and touches nothing outside a
temporary directory. Re-record it when the UI or the CLI output changes.

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
