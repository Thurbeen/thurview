#!/usr/bin/env node
// The pane's one way to write: comments, replies, thread status and the review
// decision, through thurview's own threads module - the same functions its
// HTTP API and its CLI call - so there is no second writer and no second store.
//
//   bridge.mjs list   <review>
//   bridge.mjs create <review> <document|map|review> <target hex> <review|ask> <body hex>
//   bridge.mjs reply  <review> <thread> <body hex>
//   bridge.mjs status <review> <thread> <open|resolved>
//   bridge.mjs submit <review> <approve|request-changes|close> [<body hex>]
//
// Free text travels hex-encoded both ways, so a shell never sees it and a Lua
// pane without a JSON decoder can read the answer. Every command answers with
// the review's whole thread state, one record per line, tab-separated:
//
//   R <status> <revision>
//   T <id> <kind> <mode> <status> <submitted 0|1> <target type> <target hex> <revision>
//   M <role> <body hex>                    (the messages of the T above)
//   D <decision> <revision> <body hex>
//   E <message hex>                        (on failure, with exit code 1)
//
// It reads THURVIEW_HOME like the CLI does, and needs `pnpm build` (dist/).
import { createThread, replyThread, setThreadStatus, submitReview } from "../../dist/threads.js";
import { readReview, readThreads } from "../../dist/store.js";

const hex = (s) => Buffer.from(s ?? "", "utf8").toString("hex");
const text = (h) => Buffer.from(h ?? "", "hex").toString("utf8");

function targetOf(type, key) {
  if (type === "document") return { type, blockId: key };
  if (type === "map") return { type, node: key };
  if (type === "review") return { type };
  throw new Error(`unknown target type ${type}`);
}

function keyOf(target) {
  return target.type === "document"
    ? target.blockId
    : target.type === "map"
      ? target.node
      : target.type === "file"
        ? `${target.path}:${target.line}`
        : "";
}

async function state(review) {
  const meta = await readReview(review);
  if (!meta) throw new Error(`review ${review} not found`);
  const { threads, decisions } = await readThreads(review);
  const out = [["R", meta.status, meta.revision]];
  for (const t of threads) {
    out.push([
      "T",
      t.id,
      t.kind,
      t.mode,
      t.status,
      t.submitted ? 1 : 0,
      t.target.type,
      hex(keyOf(t.target)),
      t.revision,
    ]);
    for (const m of t.messages) out.push(["M", m.role, hex(m.body)]);
  }
  for (const d of decisions) out.push(["D", d.decision, d.revision, hex(d.body)]);
  return out.map((r) => r.join("\t")).join("\n") + "\n";
}

async function main([command, review, ...rest]) {
  if (!review) throw new Error("usage: bridge.mjs <list|create|reply|status|submit> <review> ...");
  if (command === "create") {
    const [type, key, mode, body] = rest;
    if (mode !== "review" && mode !== "ask")
      throw new Error(`mode must be review or ask, not ${mode}`);
    await createThread(review, {
      // As the browser does: "Ask now" is a question delivered at once,
      // "Add to review" a comment held until the review is submitted.
      kind: mode === "ask" ? "question" : "comment",
      mode,
      target: targetOf(type, text(key)),
      body: text(body),
    });
  } else if (command === "reply") {
    await replyThread(review, rest[0], "reviewer", text(rest[1]));
  } else if (command === "status") {
    if (rest[1] !== "open" && rest[1] !== "resolved")
      throw new Error(`status must be open or resolved`);
    await setThreadStatus(review, rest[0], rest[1]);
  } else if (command === "submit") {
    const [decision, body] = rest;
    if (!["approve", "request-changes", "close"].includes(decision))
      throw new Error(`decision must be approve, request-changes or close`);
    await submitReview(review, decision, body ? text(body) : undefined);
  } else if (command !== "list") {
    throw new Error(`unknown command ${command}`);
  }
  process.stdout.write(await state(review));
}

main(process.argv.slice(2)).catch((e) => {
  process.stdout.write(`E\t${hex(e instanceof Error ? e.message : String(e))}\n`);
  process.exitCode = 1;
});
