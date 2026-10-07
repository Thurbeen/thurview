# Installing thurview

The [README](../README.md#install) has the one command most people need. This page
covers the rest.

## What the install command does

`--skill '*'` takes all six skills; quote the star so your shell does not
expand it against the current directory. `--skill` also takes names, one or
several: `--skill thurview`, or `--skill thurview thurview-fix`.

`--global` installs for your user, so one install covers every repository.
`universal` puts the one real copy of each skill under `~/.agents/skills/`,
the directory no single agent owns, and every other agent you name gets a
symlink to it - `~/.claude/skills/thurview` →
`../../.agents/skills/thurview`, and the same for the other five - so an
update lands everywhere at once. Swap `claude-code` for any agent the skills
CLI supports, but keep `universal` and at least one more: with `--yes` and a
single target, the CLI copies instead of linking.

The skills reach the `thurview` command through `npx`. Nothing else needs
installing beyond `git`: callers, tests and importers are found by the agent's
own search at the pinned commits.

## Pin to a release

The untagged URL tracks this repository's default branch: `skills update`
takes whatever `main` holds, which can be ahead of the released command. To
pin the skills to a release instead, install from the tag, which the skill
lock records and later updates keep:

```sh
npx skills@latest add https://github.com/Thurbeen/thurview/tree/v0.15.0 \
  --skill '*' --agent universal claude-code --global --yes
```

Releases tag without committing, so nothing moves the tag above: swap in the
[latest release](https://github.com/Thurbeen/thurview/releases/latest).

## Install the command

Install the command itself, rather than leaving the skills to reach it through
`npx` on every run:

```sh
npm install -g thurview     # or: pnpm add -g thurview
```

The npm package ships the same skills, so `thurview setup skill` links the
copies that match the command you have installed. Use that when you want the
two to move together; use it or the `skills` CLI, not both.

To run from a checkout instead:

```sh
pnpm install
pnpm build
npm link                    # puts `thurview` on PATH
```

## Session hooks

`thurview setup hooks` installs a SessionStart hook for Claude Code, Codex and
OpenCode, so every session opens with the reviews of its working directory.

## Coming from an older install

A skill name is an address, so nothing renames or splits one in place - the
install command adds what is missing, and what is stale has to go.

`thurview-explain` used to be a second kind inside the `thurview` skill, so an
install made before the split does not have it. Under the `skills` CLI,
updating `thurview` adds no second skill; run the install command, which
takes all six. Under `thurview setup skill`, update the command first -
`thurview update`, or pull and rebuild the checkout you linked from - and run
`thurview setup skill` again: it links every skill the installed command
carries, so it picks the new one up on its own.

`thurview-fix` was called `review-fix`, and an install made before the rename
keeps answering to `/review-fix` from a copy that will never change again.
Remove it:

```sh
npx skills@latest remove --global review-fix
```

For a `thurview setup skill` install, delete the stale link -
`~/.agents/skills/review-fix` and the same path under `~/.claude` and
`~/.cursor` - and run `thurview setup skill` again.
