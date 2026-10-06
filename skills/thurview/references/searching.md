# Searching the code

thurview builds no index of the code. Who calls a symbol, which tests touch a
file and what imports a module are answered by your own search, at the pinned
commit, and every answer you state comes with the search behind it so the
reader can run it again. Every skill that asks one of these questions uses the
recipes here.

## Search the pinned commit, not the worktree

`git grep` reads a commit directly, so its answer is the one your anchors are
pinned to however far the worktree has moved:

```sh
git grep -n -E -e '<pattern>' <commit> -- '<path glob>'
```

`<commit>` is `head` for what the change made, `base` for what it replaced.
Each hit prints as `<commit>:<path>:<line>:<text>`; the `<path>:<line>` part is
what an anchor's `peek` takes. `rg` gives the same answer, faster, only when
`git rev-parse HEAD` in the worktree is the pinned commit and the tree is
clean; when either is not true, use `git grep`.

## Recipes

Swap the name in; each one is a starting point, so read the hits before you
trust the count.

| Question                    | Search                                                                    |
| --------------------------- | ------------------------------------------------------------------------- |
| callers of a function       | `git grep -n -E -e '\bname *\(' <commit> --`                              |
| every reference to a symbol | `git grep -n -w -e 'name' <commit> --`                                    |
| callers before the change   | the same at `<base>`: a removed symbol has no callers left at head        |
| importers of a module       | `git grep -n -E -e "['\"][./]*path/to/module(\.[a-z]+)?['\"]" <commit> --` |
| tests that touch a file     | `git grep -l -w -e 'a name it exports' <commit> -- '*test*' '*spec*'`     |
| tests that name a symbol    | `git grep -n -w -e 'name' <commit> -- '*test*' '*spec*'`                  |
| the directories in a scope  | `git ls-tree -d -r --name-only <commit> -- <scope>`                       |
| the files in a scope        | `git ls-tree -r --name-only <commit> -- <scope>`                          |

`\b` is a GNU extension to `-E`; where git refuses it, use `-P` with the same
pattern.

The import recipe is written for JavaScript and TypeScript. Use the language's
own form elsewhere: `^import .*module` in Python and Go, `use crate::module` in
Rust, `alias|import|use Module` in Elixir. Test files are named per project;
check one before you rely on `*test*`.

## What a search can and cannot tell you

A text search finds names, not meaning. It misses a call made through a
variable, a re-export, a string-built name or reflection, and it matches a
comment or a different symbol with the same name. So:

- **A hit is a lead.** Open it before you call it a caller.
- **No hit is a finding about the search, not the code.** "Nothing calls
  `audit`" is true only of the forms you searched for; say which.
- **Name the search with the claim.** A sentence like "no other caller" carries
  the line that found none, so the reader can run it.

## Record what you searched

How it is recorded depends on the document:

- **An explainer** lists its searches under `searches` in `data.yaml`. Publish
  re-runs each one with `git grep -E` at the pinned commit and the Coverage tab
  counts the files it matched; see [Components](components.md). Record the ones
  that shaped what you wrote, a zero-hit one included.
- **A review or a design** has no Coverage tab. Put the search in the prose
  beside the claim it supports, as inline code.
- **A fix pass** puts it in the evidence column of its report.
