import type { ThemeRegistration } from "shiki";

/**
 * Code palette as the UI theme's tokens, not colours: app.css defines each
 * `--code-*` once per palette, so a highlighted excerpt - sealed in a revision
 * or served live - reads in whichever palette the reader has.
 */
const c = {
  bg: "var(--bg-code)",
  fg: "var(--code-fg)",
  keyword: "var(--code-keyword)",
  string: "var(--code-string)",
  function: "var(--code-function)",
  type: "var(--code-type)",
  variable: "var(--code-variable)",
  number: "var(--code-number)",
  comment: "var(--code-comment)",
  punctuation: "var(--code-punctuation)",
  operator: "var(--code-keyword)",
  tag: "var(--code-tag)",
};

export const theme: ThemeRegistration = {
  name: "thurview",
  type: "light",
  colors: { "editor.background": c.bg, "editor.foreground": c.fg },
  tokenColors: [
    {
      scope: ["comment", "punctuation.definition.comment", "string.comment"],
      settings: { foreground: c.comment, fontStyle: "italic" },
    },
    {
      scope: ["punctuation", "meta.brace", "punctuation.separator", "punctuation.terminator"],
      settings: { foreground: c.punctuation },
    },
    {
      scope: [
        "keyword",
        "storage",
        "storage.type",
        "storage.modifier",
        "keyword.control",
        "constant.language",
        "variable.language",
      ],
      settings: { foreground: c.keyword },
    },
    {
      scope: ["keyword.operator", "keyword.operator.assignment", "keyword.operator.arrow"],
      settings: { foreground: c.operator },
    },
    {
      scope: [
        "string",
        "string.quoted",
        "string.template",
        "punctuation.definition.string",
        "markup.inserted",
      ],
      settings: { foreground: c.string },
    },
    {
      scope: [
        "entity.name.function",
        "support.function",
        "meta.function-call entity.name.function",
      ],
      settings: { foreground: c.function },
    },
    {
      scope: [
        "entity.name.type",
        "entity.name.class",
        "support.class",
        "support.type",
        "entity.other.inherited-class",
        "entity.name.namespace",
      ],
      settings: { foreground: c.type },
    },
    {
      scope: [
        "constant.numeric",
        "constant.character",
        "constant.other",
        "constant.language.boolean",
      ],
      settings: { foreground: c.number },
    },
    {
      scope: [
        "entity.name.tag",
        "support.type.property-name",
        "meta.object-literal.key",
        "entity.other.attribute-name",
        "meta.property-name",
      ],
      settings: { foreground: c.tag },
    },
    {
      scope: [
        "variable",
        "variable.parameter",
        "variable.other",
        "meta.definition.variable",
        "entity.name.variable",
      ],
      settings: { foreground: c.variable },
    },
    { scope: ["markup.deleted"], settings: { foreground: c.keyword } },
    {
      scope: ["markup.heading", "entity.name.section"],
      settings: { foreground: c.tag, fontStyle: "bold" },
    },
    { scope: ["markup.bold"], settings: { fontStyle: "bold" } },
    { scope: ["markup.italic"], settings: { fontStyle: "italic" } },
  ],
};
