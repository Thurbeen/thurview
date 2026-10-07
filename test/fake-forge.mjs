#!/usr/bin/env node
// A stand-in for `gh` and `glab`, so the forge adapters are driven by tests
// rather than asserted. It logs every invocation to $FORGE_LOG and answers
// from the fixture table at $FORGE_RESPONSES: the first entry whose `match`
// substrings all appear in the command line wins.
import { appendFileSync, readFileSync, writeFileSync, renameSync } from "node:fs";

const [cli, ...args] = process.argv.slice(2);
const line = args.join(" ");
const table = JSON.parse(readFileSync(process.env.FORGE_RESPONSES, "utf8"));
const hit = table.find((e) => e.cli === cli && e.match.every((m) => line.includes(m)));

async function stdin() {
  if (!args.includes("--input")) return "";
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

const body = await stdin();
if (process.env.FORGE_LOG)
  appendFileSync(process.env.FORGE_LOG, JSON.stringify({ cli, args, body }) + "\n");

if (!hit) {
  process.stderr.write(`fake-forge: no fixture for ${cli} ${line}\n`);
  process.exit(1);
}
if (hit.fail) {
  process.stderr.write(hit.stderr ?? "fake-forge: fixture says this call fails\n");
  process.exit(1);
}
let response = hit.body;
if (hit.sequence?.length) {
  response = hit.sequence[0];
  if (hit.sequence.length > 1) {
    hit.sequence.shift();
    const staged = `${process.env.FORGE_RESPONSES}.${process.pid}`;
    writeFileSync(staged, JSON.stringify(table));
    renameSync(staged, process.env.FORGE_RESPONSES);
  }
}
process.stdout.write(typeof response === "string" ? response : JSON.stringify(response));
