import { structuredPatch } from "diff";
import { highlightLines, languageFor } from "./highlight.js";

export interface DiffRow {
  type: "context" | "add" | "del";
  oldLine?: number;
  newLine?: number;
  html: string;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  rows: DiffRow[];
}

export interface FileDiff {
  path: string;
  oldPath?: string;
  lang: string;
  binary: boolean;
  oldTotal: number;
  newTotal: number;
  hunks: DiffHunk[];
}

export function isBinary(text: string): boolean {
  return text.includes("\0");
}

export async function buildFileDiff(
  path: string,
  oldText: string | null,
  newText: string | null,
  keys: { old: string; new: string },
  oldPath?: string,
  themeName?: string,
): Promise<FileDiff> {
  const lang = languageFor(path);
  const o = oldText ?? "";
  const n = newText ?? "";
  if (isBinary(o) || isBinary(n)) {
    return {
      path,
      lang,
      binary: true,
      oldTotal: 0,
      newTotal: 0,
      hunks: [],
      ...(oldPath ? { oldPath } : {}),
    };
  }
  const oldLines = oldText === null ? [] : await highlightLines(o, lang, keys.old, themeName);
  const newLines = newText === null ? [] : await highlightLines(n, lang, keys.new, themeName);
  const patch = structuredPatch(path, path, o, n, "", "", { context: 3 });
  const hunks: DiffHunk[] = patch.hunks.map((h) => {
    let ol = h.oldStart;
    let nl = h.newStart;
    const rows: DiffRow[] = [];
    for (const line of h.lines) {
      const c = line[0];
      if (c === "+") {
        rows.push({ type: "add", newLine: nl, html: newLines[nl - 1] ?? "" });
        nl++;
      } else if (c === "-") {
        rows.push({ type: "del", oldLine: ol, html: oldLines[ol - 1] ?? "" });
        ol++;
      } else if (c === "\\") {
        continue;
      } else {
        rows.push({ type: "context", oldLine: ol, newLine: nl, html: newLines[nl - 1] ?? "" });
        ol++;
        nl++;
      }
    }
    return {
      oldStart: h.oldStart,
      oldLines: h.oldLines,
      newStart: h.newStart,
      newLines: h.newLines,
      rows,
    };
  });
  return {
    path,
    lang,
    binary: false,
    oldTotal: oldText === null ? 0 : oldLines.length,
    newTotal: newText === null ? 0 : newLines.length,
    hunks,
    ...(oldPath ? { oldPath } : {}),
  };
}
