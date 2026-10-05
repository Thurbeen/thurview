# Markdown export for an agent

In any review, design or explainer, choose **Export for agent** in the reader's
bar. The dialog previews the Markdown and offers **Copy to clipboard** and
**Download .md**. When clipboard access is unavailable, it selects the text
for manual copying. Exports also work after approval or closure, and while
viewing an earlier revision.

Without a browser:

```sh
thurview export <id> --format md --out feedback.md
thurview export --review <id> --revision 1 --out feedback.md
```

An id may be a unique prefix. With no id, the command selects the worktree's
sole document, including accepted and closed ones. Omit `--out` to receive the
complete Markdown in the `markdown` field of the normal TOON response. The
`export` record gives the selected revision, total feedback items and open
items. Export is deliberately complete; messages are never truncated.

`GET /api/reviews/<id>/export?revision=<n>` returns the same Markdown, with a
suggested filename and the same counts. Omit the revision for the current one.
A draft, invalid revision or missing sealed revision fails rather than
exporting unpinned content. Export does not submit, resolve or modify feedback.

## Document shape

The plain Markdown has these sections, always in this order:

1. An H1 with the sealed title, followed by repository name, document kind,
   branch/change request/range/scope, revision and full pinned commit hashes.
2. **Verdict**: every decision up to the selected revision, labelled with its
   revision, including the reader's decision message. Approval, request changes
   and closure without approval remain distinct. No decision says so explicitly.
3. **Reader feedback**: all threads up to that revision, including held
   comments and resolved threads. Each item names its kind, open/resolved state,
   revision, thread id and target. Code anchors are `path:start-end at <sha>`.
   Document blocks name their `review.md` line and every attached code anchor;
   map nodes name their node and attached code anchors. Targets without code
   explicitly say that no code anchor is attached. Whole-file comments name the
   file and hash without inventing a line range.
4. **What to do**: one unchecked item per open thread, referring to its numbered
   feedback item and thread id. An answered thread stays on this checklist until
   resolved. With no open threads, the section says so.

Threads are ordered by revision, then summary panels and document block order, file diff order
(path order for files outside the diff) and line, map node order, then overall
comments. Threads at the same target retain creation order. Answers remain in
message order. Decisions and thread states are live feedback: exporting an old
revision includes later answers and resolutions to its threads, but excludes
threads and decisions created on newer revisions.

Quotes use the reader's selected text where available, otherwise the sealed
Markdown or code at the thread's pinned commit. Quotes are limited to eight
lines and 600 characters, with an ellipsis when shortened. Reader and agent
messages are verbatim inside dynamically sized `text` fences, including
multiline messages and literal backticks. The Markdown adds no HTML or local
reader links, timestamps or machine paths. Repository identity is its directory
name, never its absolute location or remote URL with possible credentials.
Anchors must be relative to the repository. Exports contain the selected text
and reader feedback, so inspect that content before sharing it.

Use a thread id from the export to answer and resolve the item:

```sh
thurview threads reply <threadId> --review <id> --body "<answer>"
thurview threads resolve <threadId> --review <id>
```
