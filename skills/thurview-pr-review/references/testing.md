# Recommending a guard

A review ends; a test stays. When a finding names a concern that nothing in
the repository holds in place, the review also sketches the guard that would:
the test, rule or policy that fails the next time someone makes the same
mistake. The team adds it and CI runs it. The review never does.

## When a finding carries one

All three, or no guard:

1. **The change touches the concern.** One of the rows below, on a line the
   diff adds or alters.
2. **Nothing guards it yet.** Search for the guard at the head and name the
   search: the tool's config file, the test that would cover it.
3. **You can name the mistake it catches.** The defect you found, or the next
   plausible one. A guard for a mistake nobody can describe is ceremony.

A defect with a fix and no guard is still a finding. A missing guard with no
defect is a `tests` finding, `non-blocking`; it is `blocking` only when the
change removes or weakens a guard that existed.

## The kinds

| Kind            | Guards                                                                                     | Reach for                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `architecture`  | A layering rule, a forbidden import, a module boundary, a dependency cycle.                | dependency-cruiser, ArchUnitTS; import-linter; ArchUnit; depguard; a lint rule on imports     |
| `property`      | An invariant that holds for every input: a round trip, an ordering, a bound.               | fast-check; Hypothesis; proptest; jqwik; rapid                                                |
| `mutation`      | The strength of the tests around critical logic, where passing proves little.              | Stryker; mutmut; cargo-mutants; PIT - scoped to the module, on a schedule                     |
| `contract`      | An API, event or schema that another service or team consumes.                             | Pact; an OpenAPI or JSON Schema diff check; `buf breaking`                                    |
| `fuzz`          | A parser, decoder or handler of bytes it does not control.                                 | `go test -fuzz`; cargo-fuzz; Atheris; Jazzer; a property test fed arbitrary bytes             |
| `snapshot`      | A rendered or serialized output whose every change should be seen in review.               | the runner's snapshot; insta; syrupy; ApprovalTests                                           |
| `fitness`       | A measurable design decision: a budget, a size or complexity limit, a recorded ADR.        | a test or script asserting the number, beside the ADR that says why                           |
| `security`      | A vulnerability class or misconfiguration that can recur: a static rule, a scan, a policy. | a Semgrep rule, a CodeQL query; a secret or dependency scan; OPA, Conftest or Checkov for IaC |
| `metamorphic`   | Logic with no known right answer, where related inputs must give related outputs.          | the repo's own runner: permute, scale or duplicate the input and compare the two outputs      |
| `resilience`    | Behaviour when a dependency is slow, down or wrong: timeout, retry, fallback.              | a fault-injecting test double; Toxiproxy; a chaos experiment for a deployed system            |
| `accessibility` | A UI's roles, labels, contrast and keyboard path.                                          | axe-core in the component or browser tests; pa11y; Lighthouse CI                              |

Which finding tends to carry which:

| The finding                                           | The guard                  |
| ----------------------------------------------------- | -------------------------- |
| A dependency against the grain, a bypassed seam       | `architecture`             |
| A contract changed in place, foreign storage access   | `contract`, `architecture` |
| A design limit the change crosses or sets             | `fitness`                  |
| A bug in an invariant, an edge the examples miss      | `property`, `metamorphic`  |
| A test that passes with the guard removed             | `mutation`                 |
| An injection, a missing check, a secret, a wide grant | `security`                 |
| Untrusted bytes parsed                                | `fuzz`                     |
| A timeout, retry or partial failure handled wrongly   | `resilience`               |
| A format or rendering that changed unseen             | `snapshot`                 |
| A UI control added or changed                         | `accessibility`            |

## Choosing the tool

- **Use what the repository has.** Read its manifest, lockfile and CI config
  first. A property test in the runner already there beats a new framework.
- **A new tool is a cost, and a supply-chain change.** Say in the finding's
  body that it is new. Name no version: the team checks the registry.
- **Fit the language.** Each row mixes ecosystems in no fixed order; pick the
  tool that exists for the code under review.
- **One guard per finding**, the cheapest that catches the mistake. An
  architecture test over a mutation run; a lint rule over an architecture
  test when one line says it.

## Writing the sketch

`guard` on the finding in `pass.json`: `kind`, `tool`, `lang`, and a `sketch`
of at most 15 lines. `sync` folds it under the fix in the finding's thread.

- **Real names.** The module, function and path from the diff, in the
  repository's own test style. A reader pastes it and fills in little.
- **The one case that matters.** The rule or property that catches the named
  mistake, not a suite.
- **Say where it goes** in the first line when it is not obvious: a path as
  the file's comment.
- **Never run it.** No suite, mutation tool, fuzzer or scanner runs to
  produce or check a sketch. It is a recommendation, read and adopted by the
  team, and it does not change the finding's severity.

A layering rule, for dependency-cruiser:

```js
// .dependency-cruiser.cjs
module.exports = {
  forbidden: [
    {
      name: "core-stays-free-of-adapters",
      severity: "error",
      from: { path: "^src/core" },
      to: { path: "^src/adapters" },
    },
  ],
};
```

An invariant, for Hypothesis:

```python
# tests/test_money.py
@given(st.integers(min_value=0), st.integers(min_value=1, max_value=12))
def test_split_loses_no_cent(total, parts):
    assert sum(split(total, parts)) == total
```

A recurring vulnerability class, for Semgrep:

```yaml
# .semgrep/sql.yml
rules:
  - id: no-sql-built-by-format
    languages: [python]
    severity: ERROR
    message: Pass values as query parameters, never by string formatting.
    pattern-either:
      - pattern: $DB.execute(f"...", ...)
      - pattern: $DB.execute("..." % ..., ...)
```

## Proportion

- **Few.** Most findings carry no guard. A review that attaches one to every
  thread has stopped choosing.
- **The decision before the test.** When the rule the guard enforces is
  written nowhere, the first step is the ADR; the `fitness` or `architecture`
  guard then enforces what it says.
- **Not a coverage audit.** The review does not measure coverage or list
  untested lines; it names the one concern this change left unguarded.
