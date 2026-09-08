import { describe, expect, it } from "vitest";
import type { CompiledMap } from "../src/document/compile.js";
import {
  changedInside,
  childrenOf,
  collect,
  neighboursOf,
  rankEdges,
  routeIn,
} from "../src/ui/views/map-model.js";

// A system whose change landed in one container: Auth changed, Audit is new,
// Store and the reader are its untouched context.
const map: CompiledMap = {
  head: {
    nodes: [
      { id: "user", kind: "person", label: "User" },
      { id: "svc", kind: "system", label: "Session service" },
      { id: "svc.store", kind: "component", label: "Session store", files: ["src/store.ts"] },
      { id: "svc.auth", kind: "container", label: "Auth", files: ["src/auth.ts"] },
      { id: "svc.audit", kind: "component", label: "Audit trail", files: ["src/audit.ts"] },
    ],
    edges: [
      { from: "user", to: "svc.auth", label: "logs in and out" },
      { from: "svc.auth", to: "svc.store", label: "reads sessions" },
      { from: "svc.auth", to: "svc.audit", label: "records attempts" },
    ],
  },
  base: {
    nodes: [
      { id: "user", kind: "person", label: "User" },
      { id: "svc", kind: "system", label: "Session service" },
      { id: "svc.store", kind: "component", label: "Session store", files: ["src/store.ts"] },
      { id: "svc.auth", kind: "container", label: "Auth" },
      { id: "svc.gone", kind: "component", label: "Legacy cookie", files: ["src/cookie.ts"] },
    ],
    edges: [{ from: "user", to: "svc.auth", label: "logs in and out" }],
  },
  diff: { added: ["svc.audit"], removed: ["svc.gone"], changed: ["svc", "svc.auth"] },
  filesByNode: { svc: ["src/auth.ts", "src/audit.ts"], "svc.auth": ["src/auth.ts"] },
};

describe("map guidance", () => {
  it("carries a removed node over from base and stamps every status", () => {
    const all = collect(map);
    expect(all.get("svc.gone")?.status).toBe("removed");
    expect(all.get("svc.gone")?.label).toBe("Legacy cookie");
    expect(all.get("svc.audit")?.status).toBe("added");
    expect(all.get("svc.auth")?.status).toBe("changed");
    expect(all.get("user")?.status).toBe("");
  });

  it("puts what the change touched before its untouched context", () => {
    const all = collect(map);
    // Authored order is store, auth, audit, and store is the untouched one.
    expect(childrenOf(all, "svc", map.filesByNode).map((n) => n.id)).toEqual([
      "svc.auth",
      "svc.audit",
      "svc.gone",
      "svc.store",
    ]);
    // The top level: the system holds the change, the reader is context.
    expect(childrenOf(all, "", map.filesByNode).map((n) => n.id)).toEqual(["svc", "user"]);
  });

  it("counts the change hidden inside a node the reader has not opened", () => {
    const all = collect(map);
    expect(changedInside(all, "svc")).toBe(3);
    expect(changedInside(all, "svc.auth")).toBe(0);
  });

  it("routes the reader to the node the change landed hardest in", () => {
    const all = collect(map);
    const route = routeIn(all, map.filesByNode);
    expect(route?.id).toBe("svc.auth");
    // No change at all means nowhere to send them.
    const quiet = { ...map, diff: { added: [], removed: [], changed: [] }, filesByNode: {} };
    expect(routeIn(collect(quiet), {})).toBeNull();
  });

  it("reads a node's neighbours in both directions", () => {
    expect(neighboursOf(map, "svc.auth")).toEqual([
      { dir: "out", other: "svc.store", label: "reads sessions" },
      { dir: "out", other: "svc.audit", label: "records attempts" },
      { dir: "in", other: "user", label: "logs in and out" },
    ]);
  });

  it("floats the edges that touch the change to the top of the list", () => {
    const all = collect(map);
    const ranked = rankEdges(
      [
        { from: "user", to: "svc.auth" },
        { from: "svc.store", to: "user" },
        { from: "svc.auth", to: "svc.audit" },
      ],
      all,
    );
    expect(ranked.map((e) => [e.edge.from, e.edge.to, e.touchesChange])).toEqual([
      ["svc.auth", "svc.audit", true],
      ["user", "svc.auth", true],
      ["svc.store", "user", false],
    ]);
  });

  it("marks an edge folded up to a container that only hides the change", () => {
    // The shape the view actually hands rankEdges: links are folded up to the
    // parts on screen, and a container that owns no files of its own carries
    // no status while its leaf does. The seam is still a seam.
    const hidden: CompiledMap = {
      head: {
        nodes: [
          { id: "user", kind: "person", label: "User" },
          { id: "svc", kind: "system", label: "Session service" },
          { id: "svc.auth", kind: "container", label: "Auth", files: ["src/auth.ts"] },
        ],
        edges: [{ from: "user", to: "svc.auth" }],
      },
      base: null,
      diff: { added: [], removed: [], changed: ["svc.auth"] },
      filesByNode: { "svc.auth": ["src/auth.ts"] },
    };
    const all = collect(hidden);
    expect(all.get("svc")?.status).toBe("");
    expect(rankEdges([{ from: "user", to: "svc" }], all)[0]?.touchesChange).toBe(true);
  });
});
