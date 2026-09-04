import type { ThemeRegistration } from "shiki";

/** Code palette matching the UI theme: warm charcoal ground, red accent, green strings, yellow names. */
export const theme: ThemeRegistration = {
  name: "thurview",
  type: "dark",
  colors: { "editor.background": "#0d0b09", "editor.foreground": "#e0e0e0" },
  tokenColors: [
    {
      scope: ["comment", "punctuation.definition.comment", "string.comment"],
      settings: { foreground: "#948a7d", fontStyle: "italic" },
    },
    {
      scope: ["punctuation", "meta.brace", "punctuation.separator", "punctuation.terminator"],
      settings: { foreground: "#948a7d" },
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
      settings: { foreground: "#ff8c8c" },
    },
    {
      scope: ["keyword.operator", "keyword.operator.assignment", "keyword.operator.arrow"],
      settings: { foreground: "#ff5c54" },
    },
    {
      scope: [
        "string",
        "string.quoted",
        "string.template",
        "punctuation.definition.string",
        "markup.inserted",
      ],
      settings: { foreground: "#6eff6e" },
    },
    {
      scope: [
        "entity.name.function",
        "support.function",
        "meta.function-call entity.name.function",
        "entity.name.type",
        "entity.name.class",
        "support.class",
        "support.type",
        "entity.other.inherited-class",
        "entity.name.namespace",
      ],
      settings: { foreground: "#ffb627" },
    },
    {
      scope: [
        "constant.numeric",
        "constant.character",
        "constant.other",
        "constant.language.boolean",
      ],
      settings: { foreground: "#ffb627" },
    },
    {
      scope: [
        "entity.name.tag",
        "support.type.property-name",
        "meta.object-literal.key",
        "entity.other.attribute-name",
        "meta.property-name",
      ],
      settings: { foreground: "#ff5c54" },
    },
    {
      scope: [
        "variable",
        "variable.parameter",
        "variable.other",
        "meta.definition.variable",
        "entity.name.variable",
      ],
      settings: { foreground: "#00d9ff" },
    },
    { scope: ["markup.deleted"], settings: { foreground: "#ff3b30" } },
    {
      scope: ["markup.heading", "entity.name.section"],
      settings: { foreground: "#ff5c54", fontStyle: "bold" },
    },
    { scope: ["markup.bold"], settings: { fontStyle: "bold" } },
    { scope: ["markup.italic"], settings: { fontStyle: "italic" } },
  ],
};
