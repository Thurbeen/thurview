/**
 * The closed sets a change request review speaks in. Each is an enum in code
 * and a table in `skills/thurview-pr-review/SKILL.md`, and a test holds the
 * two to the same words: a category the docs do not define is one an author
 * cannot act on, and one the code does not know is one the summary cannot
 * count.
 */

/** Every finding is exactly one of these. Order is the summary table's order. */
export const CATEGORIES = {
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
    definition: "The next change here is harder: duplication, dead code, a misleading name.",
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
