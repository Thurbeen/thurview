import { describe, expect, it } from "vitest";
import { boxW, layoutFlow, type Flow } from "../src/ui/flow-layout.js";

// A sign-up with two retries: a failed code goes back to asking for one, and
// a refused password goes back to the very start.
const flow: Flow = {
  id: "f",
  line: 1,
  type: "flow",
  label: "Sign-up",
  steps: [
    { id: "email", label: "Enter email", actor: "user", decision: false },
    { id: "send", label: "Send code", anchor: "send", decision: false },
    { id: "code", label: "Code valid?", anchor: "check", decision: true },
    { id: "pass", label: "Password strong?", anchor: "pw", decision: true },
    { id: "done", label: "Account created", anchor: "create", decision: false },
  ],
  edges: [
    { from: "email", to: "send" },
    { from: "send", to: "code" },
    { from: "code", to: "pass", case: "yes" },
    { from: "code", to: "send", case: "no" },
    { from: "pass", to: "done", case: "yes" },
    { from: "pass", to: "email", case: "no" },
  ],
};

// A loop's path is `M… V… H<lane> V… H… V…`: the first horizontal run ends at
// the lane it climbs.
const laneOf = (d: string) => Number(/H(-?[\d.]+)/.exec(d)![1]);

describe("flow layout", () => {
  it("climbs each loop in its own lane, clear of the boxes", () => {
    const { width, at, edges } = layoutFlow(flow);
    const loops = edges.filter((e) => e.back);
    expect(loops.map((e) => e.edge.to)).toEqual(["send", "email"]);
    const lanes = loops.map((e) => laneOf(e.d));
    expect(new Set(lanes).size).toBe(2);
    const rightmostBox = Math.max(...flow.steps.map((s) => at(s.id).x + boxW));
    for (const x of lanes) {
      expect(x).toBeGreaterThan(rightmostBox);
      expect(x).toBeLessThan(width);
    }
    // The longer loop runs outside the shorter one, so the two never cross.
    expect(lanes[1]).toBeGreaterThan(lanes[0]!);
  });

  it("keeps a flow with no loop free of lanes", () => {
    const straight = { ...flow, edges: flow.edges.filter((e) => e.case !== "no") };
    expect(layoutFlow(straight).edges.some((e) => e.back)).toBe(false);
  });

  it("names each loop leaving one step on a line of its own", () => {
    // A check that can send the reader back to either earlier step, and on
    // to one of two steps side by side below it.
    const branchy: Flow = {
      ...flow,
      steps: [
        ...flow.steps.slice(0, 2),
        { id: "check", label: "Code valid?", anchor: "check", decision: true },
        { id: "done", label: "Account created", anchor: "create", decision: false },
        { id: "help", label: "Ask for help", decision: false },
      ],
      edges: [
        { from: "email", to: "send" },
        { from: "send", to: "check" },
        { from: "check", to: "done", case: "yes" },
        { from: "check", to: "help", case: "stuck" },
        { from: "check", to: "send", case: "resend" },
        { from: "check", to: "email", case: "start over" },
      ],
    };
    const { edges, at } = layoutFlow(branchy);
    const mine = edges.filter((e) => e.edge.from === "check");
    const loops = mine.filter((e) => e.back);
    expect(loops).toHaveLength(2);
    // Each loop's name is a 10.5px line away from every other label of its step.
    for (const loop of loops) {
      // beside its stem, where no other loop's lane runs
      expect(loop.label).toMatchObject({ x: at("check").cx + 6, at: "start" });
      for (const other of mine.filter((e) => e !== loop))
        expect(Math.abs(loop.label.y - other.label.y)).toBeGreaterThanOrEqual(12);
    }
  });

  it("names no loop where a branch drops through its label", () => {
    // A decision with a step below it on either side, each branch named, and
    // two loops back up: the lower line beside the stem lies across the
    // drop into the right-hand step.
    const crowded: Flow = {
      ...flow,
      steps: [
        { id: "a", label: "Ask", decision: false },
        { id: "b", label: "Send", decision: false },
        { id: "c", label: "Valid?", decision: true },
        { id: "l", label: "Done", decision: false },
        { id: "r", label: "Stuck", decision: false },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
        { from: "c", to: "l", case: "yes" },
        { from: "c", to: "r", case: "stuck" },
        { from: "c", to: "b", case: "resend" },
        { from: "c", to: "a", case: "ask support for help" },
      ],
    };
    for (const f of [flow, crowded]) {
      const { edges } = layoutFlow(f);
      // Every vertical run, and each label as a box 7.3px a character wide.
      const runs = edges.flatMap(({ d }) => {
        let x = 0,
          y = 0;
        return d.match(/[MVH][^MVH]*/g)!.flatMap((n) => {
          const v = Number(n.slice(1).split(",")[0]);
          if (n[0] === "M") [x, y] = n.slice(1).split(",").map(Number) as [number, number];
          else if (n[0] === "H") x = v;
          else {
            const run = { x, from: Math.min(y, v), to: Math.max(y, v) };
            y = v;
            return [run];
          }
          return [];
        });
      });
      for (const { edge, label } of edges.filter((e) => e.edge.case)) {
        // 10.5px mono, cut to its room when it has to be
        const w = Math.min(edge.case!.length * 10.5 * 0.605, label.room ?? Infinity);
        const left =
          label.at === "start" ? label.x : label.at === "end" ? label.x - w : label.x - w / 2;
        const crossed = runs.filter(
          (r) => r.x > left && r.x < left + w && r.from < label.y && r.to > label.y - 12,
        );
        expect.soft(crossed, edge.case).toEqual([]);
      }
    }
  });
});
