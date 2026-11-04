// The built UI is served on every page load and copied whole into every
// exported page and every published snapshot, so its size is a contract: a
// bundle that grows past these budgets is a change to think about, not an
// accident to ship.
import { it, expect } from "vitest";
import { stat } from "node:fs/promises";
import { join } from "node:path";

const UI = join(import.meta.dirname, "..", "dist", "ui");

it.each([
  ["app.js", 100_000],
  ["app.css", 45_000],
])("dist/ui/%s stays under %i bytes", async (file, budget) => {
  expect((await stat(join(UI, file))).size).toBeLessThan(budget);
});
