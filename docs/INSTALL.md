# Installing thurview

The [README](../README.md#install) has the one command most people need. This page
covers the rest.

## What the install command does

`--skill '*'` takes every skill the repository ships, which is
`thurview-pr-review`; quote the star so your shell does not expand it against
the current directory. `--skill thurview-pr-review` names it outright.

`--global` installs for your user, so one install covers every repository.
`universal` puts the one real copy of the skill under `~/.agents/skills/`,
the directory no single agent owns, and every other agent you name gets a
symlink to it - `~/.claude/skills/thurview-pr-review` →
`../../.agents/skills/thurview-pr-review` - so an update lands everywhere at
once. Swap `claude-code` for any agent the skills CLI supports, but keep
`universal` and at least one more: with `--yes` and a single target, the CLI
copies instead of linking.

The skill reaches the `thurview` command through `npx`. Nothing else needs
installing beyond `git` and the forge's CLI, `gh` or `glab`.

## Pin to a release

The untagged URL tracks this repository's default branch: `skills update`
takes whatever `main` holds, which can be ahead of the released command. To
pin the skill to a release instead, install from the tag, which the skill
lock records and later updates keep:

```sh
npx skills@latest add https://github.com/Thurbeen/thurview/tree/v0.25.0 \
  --skill '*' --agent universal claude-code --global --yes
```

Releases tag without committing, so nothing moves the tag above: swap in the
[latest release](https://github.com/Thurbeen/thurview/releases/latest).

## Install the command

Install the command itself, rather than leaving the skill to reach it through
`npx` on every run:

```sh
npm install -g thurview     # or: pnpm add -g thurview
```

The npm package ships the same skill, so `thurview setup skill` links the
copy that matches the command you have installed. Use that when you want the
two to move together; use it or the `skills` CLI, not both.

To run from a checkout instead:

```sh
pnpm install
pnpm build
npm link                    # puts `thurview` on PATH
```

## Coming from an older install

A skill name is an address, so nothing removes one in place - the install
command adds what is missing, and what is stale has to go.

thurview is now the PR/MR review alone. The browser page and everything that
made it are gone: the `thurview`, `thurview-fix` and `thurview-publish`
skills, and the `scaffold`, `publish`, `publish-static`, `open`, `export`,
`serve`, `wait`, `threads`, `forge`, `info`, `delete` and `setup hooks`
commands, and the top-level `stop` that ended the page server. An install
made before that keeps those skills from a copy that will never change
again. Remove them, along with the older
`thurview-explain`, `thurview-design` and `review-fix`:

```sh
npx skills@latest remove --global thurview thurview-fix thurview-publish \
  thurview-explain thurview-design review-fix
```

For a `thurview setup skill` install, delete the stale links under
`~/.agents/skills`, `~/.claude/skills` and `~/.cursor/skills` and run
`thurview setup skill` again. A SessionStart hook from `thurview setup hooks`
stays until you remove it from your agent's settings. Reviews stored under
`~/.thurview/reviews` from the page flow are no longer read; delete that
directory when you no longer need them.
