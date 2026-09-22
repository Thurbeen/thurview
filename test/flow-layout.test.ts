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
});
