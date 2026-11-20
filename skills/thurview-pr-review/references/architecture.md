# Reviewing the architecture

A bug in a line costs one fix. A defect in the design costs a fix per caller,
and each one is a small `if` that hides the design further. So every review
answers two questions before it hunts for bugs:

1. **Does the change put its logic in the right place?** The module that owns
   the data or the rule, behind the seam meant for it, with dependencies
   running the way the rest of the system runs them.
2. **Does it fix the cause, or patch a symptom?** A special case added where
   the failure showed up, instead of removing what let it happen.

A "no" to either is an `architecture` finding, and it outranks a bug in the
same code: fixing the design usually removes the bug.

## The patch test

Run it on every fix the change makes, and on every bug you find yourself.

```mermaid
flowchart TD
  A[A bug, or a fix for one] --> B{Why could this bug be written at all?}
  B -->|a typo, an off-by-one, a wrong operator| C[Local bug: fix the line]
  B -->|a property of the design| D{Would the next caller hit it too?}
  D -->|no| C
  D -->|yes| E[Architecture finding: name the property and the target shape]
```

"A property of the design" is one of these: two places hold the same fact; a
type allows a state the code then has to check for; a rule lives in its callers
instead of its owner; a module reaches past an interface into an
implementation. A conditional is the right fix only when the rule genuinely
belongs at that spot. When it does not, the conditional is the symptom patch,
and the right fix removes the class of bug: make the invalid state
unrepresentable, move the rule to its owner, derive both copies from one
source, put the variation behind the interface that already exists.

## What a defect looks like

Each row is something a diff shows and a search confirms. The search is what
turns a suspicion into a finding the reader can check: run it at `<head>`, and
at `<base>` to tell what the change introduced from what it inherited.

<!-- prettier-ignore -->
| Defect | In the diff | Confirm with |
| --- | --- | --- |
| Symptom patch | A new branch on one input, kind, caller or flag, or a `catch` that swallows one error, at the failure site. | The same discriminant elsewhere: `git grep -n -E -e "kind *=+ *['\"]foo" <head> --` |
| Scattered switch | Another case added to a `switch`/`if` chain on a type tag that other modules also switch on. | Every place that tests the tag: `git grep -n -E -e '\.kind *=+' <head> --` |
| Misplaced responsibility | A rule computed in a layer that does not own it: a handler doing storage, a view doing business logic. | Where else the rule is computed; who owns the data it reads. |
| Dependency against grain | A lower layer importing a higher one, core importing an adapter, a new import cycle. | The importers recipe in both directions between the two modules. |
| Duplicated source of truth | A list, constant, schema or validation rule written a second time. | The literal or key at head: `git grep -n -F -e '<literal>' <head> --` |
| Interface bent to a caller | A parameter, option or flag added to a shared function that one caller passes. | Callers of the function, and which of them pass it. |
| Bypassed seam | A caller reaching into another module's internals, or around the interface it already has. | Other callers of the same internals; the interface they were meant to use. |
| Hidden coupling | Module-level mutable state, a singleton, an init order the change starts to depend on. | Every reader and writer of that state. |
| Foreign storage access | A query, client or connection to a table, bucket, topic or cache that another service or module owns. | The owner: who migrates that schema, and its other readers and writers. |
| Second writer | A new write path to data that already has an owner. | Every writer of the field or table; the invariant each one must now repeat. |
| Contract changed in place | A field removed, renamed, retyped or made required in an API, event or schema, with no version or overlap. | Its consumers at head; when they live in another repository, a risk bullet. |
| Low cohesion | A module gaining a second reason to change: an unrelated function in `utils`, a type serving two domains. | Importers of the new symbol against importers of the old ones. |
| Speculative generality | An interface, layer, option or config with one implementation and one caller. | Implementations and callers at head: `git grep -n -e '<name>' <head> --` |
| One-way door | A migration that drops or rewrites data, a persisted id or format, a public name - with no way back. | The down path, and every reader of the old shape. |

A text search finds names, not meaning, so the rules in
[Searching the code](searching.md) hold here too: open each hit, and name the
search beside the claim it supports.

## Failure modes and operability

A design that only works when everything works is a design defect. For every
call the change adds across a process or network boundary, and every write:

- **Timeout and retry**: is there a timeout; is the retry bounded, backed off,
  and safe to repeat - idempotent, or keyed?
- **Partial failure**: two writes with no transaction or outbox - what state
  is left when the process dies between them, and who repairs it?
- **Bounds**: a queue, cache, loop, batch or fan-out that grows with input and
  has no limit.
- **Seeing it**: does the failure path log or count what an operator needs -
  which item, which dependency - with no secret in it?
- **Undoing it**: a flag, a rollback, a migration that runs both ways. What
  does reverting this change leave behind?

A "no" on a line the diff adds is a `reliability` finding, or `architecture`
when the shape itself forces the failure. Several of these have a guard - a
`resilience` check, a `contract` test, a `fitness` function - per
[Recommending a guard](testing.md).

## Writing the finding

An architecture finding is guidance toward a better shape, not a complaint.
It carries three things, each pointing at `path:line` at the head:

- **The cause**: the design property, in one line, with the evidence - the
  search and its hits, or the two lines that hold the same fact.
- **The target**: where the logic should live, which way the dependency should
  run, which single source the copies should derive from. Name the module,
  type or interface; "refactor this" is not a target.
- **The step**: the smallest change that moves toward the target, and whether
  it belongs in this change or a follow-up. A target nobody can take a step
  toward is an opinion.
- **The guard**, when the rule can be checked by a machine: an
  `architecture` test or a `fitness` function that keeps the next change from
  reintroducing it, per [Recommending a guard](testing.md).

Example: _The `retries === 0` guard patches one caller; `upload()` and
`sync()` each decide retry policy (`git grep -n -e 'retries' <head>` → 4 sites
in 3 files). Target: one `RetryPolicy` passed in by the caller. Step: move the
two existing checks into it here; the other callers can follow._

## Proportion

- **Severity follows what the change did.** It is blocking when the change
  introduces the defect or deepens it: a new cycle, a second source of truth,
  another case on a switch that is already scattered, a special case where the
  owner should change. A defect the change sits next to but does not make worse
  is the base's, not this change's: name it as context, not as a finding.
- **The fix asked for scales with the change.** A one-line fix that deepens a
  design problem gets a finding with a small step, not a demand for a rewrite.
  Say when the right move is a follow-up, and say what it is.
- **Evidence beats taste.** A preferred pattern, a naming style or "I would
  have split this differently" is not a defect. A defect has a cost you can
  show: a second place that must change in step, a caller that will hit the
  same bug, a dependency the rest of the system does not take.
- **No defect is an answer; no view is not.** When the change puts its logic
  where it belongs and fixes causes, say so in the pass's `architecture`
  line, and how you know.
