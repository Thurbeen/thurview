/**
 * The closed sets a change request review speaks in. Each is an enum in code
 * and a table in `skills/thurview-pr-review/SKILL.md`, and a test holds the
 * two to the same words: a category the docs do not define is one an author
 * cannot act on, and one the code does not know is one the summary cannot
 * count.
 */

/**
 * Every finding is exactly one of these. Order is the summary table's order,
 * and architecture leads it: a defect in the design outlives every bug it
 * produces, and patching those one by one buries it.
 */
export const CATEGORIES = {
  architecture: {
    label: "Architecture",
    definition:
      "The design is wrong, not a line: a special case patching a symptom, logic in the wrong place, a dependency against the grain.",
  },
  bug: { label: "Bug", definition: "The code does the wrong thing for an input it accepts." },
  security: {
    label: "Security",
    definition: "An attacker gains access, data or execution they should not have.",
  },
  performance: {
    label: "Performance",
    definition: "Time, memory or calls grow worse than the change needs.",
  },
  reliability: {
    label: "Reliability",
    definition: "A failure, retry, timeout or race is handled wrongly or not at all.",
  },
  compatibility: {
    label: "Compatibility",
    definition: "A public API, schema, config, flag or data format breaks its callers.",
  },
  maintainability: {
    label: "Maintainability",
    definition:
      "The next change here is harder, locally: duplication, dead code, a misleading name.",
  },
  tests: {
    label: "Tests",
    definition: "A behaviour the change adds or alters is not tested, or a test proves nothing.",
  },
  docs: {
    label: "Docs",
    definition: "A comment, README or doc now says something the code does not do.",
  },
} as const;

export type Category = keyof typeof CATEGORIES;
export const CATEGORY_IDS = Object.keys(CATEGORIES) as [Category, ...Category[]];

export const GUARDS = {
  architecture: {
    label: "Architecture test",
    guards: "A layering rule, a forbidden import, a module boundary, a dependency cycle.",
  },
  property: {
    label: "Property test",
    guards: "An invariant that holds for every input: a round trip, an ordering, a bound.",
  },
  mutation: {
    label: "Mutation testing",
    guards: "The strength of the tests around critical logic, where passing proves little.",
  },
  contract: {
    label: "Contract test",
    guards: "An API, event or schema that another service or team consumes.",
  },
  fuzz: {
    label: "Fuzz target",
    guards: "A parser, decoder or handler of bytes it does not control.",
  },
  snapshot: {
    label: "Snapshot test",
    guards: "A rendered or serialized output whose every change should be seen in review.",
  },
  fitness: {
    label: "Fitness function",
    guards: "A measurable design decision: a budget, a size or complexity limit, a recorded ADR.",
  },
  security: {
    label: "Security check",
    guards:
      "A vulnerability class or misconfiguration that can recur: a static rule, a scan, a policy.",
  },
  metamorphic: {
    label: "Metamorphic test",
    guards: "Logic with no known right answer, where related inputs must give related outputs.",
  },
  resilience: {
    label: "Resilience check",
    guards: "Behaviour when a dependency is slow, down or wrong: timeout, retry, fallback.",
  },
  accessibility: {
    label: "Accessibility check",
    guards: "A UI's roles, labels, contrast and keyboard path.",
  },
} as const;

export type GuardKind = keyof typeof GUARDS;
export const GUARD_KINDS = Object.keys(GUARDS) as [GuardKind, ...GuardKind[]];

/** `blocking` must be fixed before merge; `nit` is taste, and says so. */
export const SEVERITIES = ["blocking", "non-blocking", "nit"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** How safe the change is to merge, as the summary's first number. */
export const CONFIDENCE = {
  1: "Do not merge: it breaks something that works today.",
  2: "Not yet: a blocking finding is open.",
  3: "Unsure: a risk is named that the review could not rule out.",
  4: "Not yet: non-blocking findings are worth a look before merge.",
  5: "Safe to merge; nothing open beyond nits.",
} as const;
