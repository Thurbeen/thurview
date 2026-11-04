# Declaring what is in scope

By default every path in the repository is readable at the pinned commits. A
repository can invert that with `thurview-scope.yaml` at its root:

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
`exclude` entry is a prefix of it.

## The rules

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

## Where the rules apply

The rules apply in both places a document is read from, because they are fed
from different places. At `publish`: a peek at an excluded file is an error, and
the sealed revision's file list and its map's file lists hold nothing
excluded. At serving: the diff, the file, the symbol index and each commit's
path list are read from git per request, and each refuses an excluded path with
**"excluded by scope"** - not a 404, which would claim the file is not there.
A glob is applied in both, through the same matcher. HTML export applies the
same rules to diffs, file contents and commit file lists, including files a
thread points at. A thread's text and target remain as written.

`thurview-scope.yaml` itself is always readable, so a reader can read the rule
that withheld a file. A revision is served back exactly as it was sealed, so each
one records the rules it was sealed under, in full. Widening them later costs
nothing: a revision holds only what the rules in force when it was sealed let in,
so if all of that is still allowed it stays readable. Narrowing them is what the
record is for - the older revisions are refused with the same words until
`thurview publish` seals one under the rules in force, and that is the deliberate
price of not serving what the rules now withhold. `scaffold` and `publish`
print the rules and how many changed files they withheld, and the Files tab
says so above the list; the count a reader sees is the one the revision they
are reading was sealed with, so it describes that file list and not whatever
the pins have moved on to.

## What the scope does not decide

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
