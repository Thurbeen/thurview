import type { ThemeRegistration } from "shiki";

/** Code palette of the one UI theme: the `--bg-code` ground, every token at WCAG AA on it. */
const c = {
  bg: "#f6f8fa",
  fg: "#1f2328",
  keyword: "#cf222e",
  string: "#0a3069",
  function: "#6639ba",
  type: "#953800",
  variable: "#0550ae",
  number: "#0550ae",
  comment: "#5f6773",
  punctuation: "#57606a",
  operator: "#cf222e",
  tag: "#116329",
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
