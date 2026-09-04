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

## Releases

`cd.yml` runs on every push to `main`. cocogitto decides from the commits
whether a version is due, tags it, publishes to npm with provenance and writes
the GitHub release. There is no CHANGELOG file in the tree.
