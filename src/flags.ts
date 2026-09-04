import { AxiError } from "axi-sdk-js";

export type FlagKind = "string" | "boolean";
export interface FlagSpec {
  [name: string]: { kind: FlagKind; help: string; default?: string };
}

export interface Parsed {
  flags: Record<string, string | boolean | undefined>;
  positional: string[];
}

/** Parse `args` against `spec`. Unknown flags fail loudly with the valid set inline (exit 2). */
export function parseFlags(
  command: string,
  args: string[],
  spec: FlagSpec,
  positionalMax = 0,
): Parsed {
  const flags: Parsed["flags"] = {};
  const positional: string[] = [];
  const valid = Object.keys(spec).map((k) => `--${k}`);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--help") continue;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = (eq > 0 ? a.slice(2, eq) : a.slice(2)).replace(/^no-/, "");
      const negated = a.startsWith("--no-");
      const s = spec[name];
      if (!s) {
        throw new AxiError(
          `unknown flag ${a.split("=")[0]} for \`${command}\``,
          "VALIDATION_ERROR",
          [
            `valid flags for \`${command}\`: ${valid.join(", ") || "(none)"} (--help always allowed)`,
          ],
        );
      }
      if (s.kind === "boolean") {
        flags[name] = !negated;
      } else {
        const v = eq > 0 ? a.slice(eq + 1) : args[++i];
        if (v === undefined || v.startsWith("--"))
          throw new AxiError(`--${name} needs a value`, "VALIDATION_ERROR", [
            `${command} --${name} <value>`,
          ]);
        flags[name] = v;
      }
    } else if (a.startsWith("-") && a.length > 1) {
      throw new AxiError(`unknown flag ${a} for \`${command}\``, "VALIDATION_ERROR", [
        `valid flags for \`${command}\`: ${valid.join(", ") || "(none)"}`,
      ]);
    } else {
      positional.push(a);
    }
  }
  if (positional.length > positionalMax) {
    throw new AxiError(`unexpected argument ${positional[positionalMax]}`, "VALIDATION_ERROR", [
      `Run \`thurview ${command} --help\``,
    ]);
  }
  for (const [k, s] of Object.entries(spec))
    if (flags[k] === undefined && s.default !== undefined) flags[k] = s.default;
  return { flags, positional };
}

export function str(p: Parsed, name: string): string | undefined {
  const v = p.flags[name];
  return typeof v === "string" ? v : undefined;
}
export function bool(p: Parsed, name: string): boolean {
  return p.flags[name] === true;
}

export function helpFor(
  command: string,
  description: string,
  spec: FlagSpec,
  examples: string[],
  args: string = "",
): Record<string, unknown> {
  const flags: Record<string, string> = {};
  for (const [k, s] of Object.entries(spec))
    flags[`--${k}${s.kind === "string" ? " <value>" : ""}`] =
      s.default !== undefined ? `${s.help} (default: ${s.default})` : s.help;
  return { command: `thurview ${command}${args ? " " + args : ""}`, description, flags, examples };
}
