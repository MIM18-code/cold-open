import test from "node:test";
import assert from "node:assert/strict";
import { planGroups } from "../src/renderer/features/backlot/plan-text.ts";

test("Backlot's import plan reads as writer-facing groups", () => {
  const plan = { unresolved: [], matched: [{ number: "1", heading: "INT. ROOM - DAY" }], headingChanged: [{ number: "2", heading: "EXT. CUL-DE-SAC - NIGHT", previousHeading: "EXT. STREET - NIGHT" }],
    pagesChanged: [{ number: "3", heading: "INT. TRUCK - NIGHT", pagesChanged: { from: 9, to: 4 } }], castRemoved: [{ number: "4", heading: "EXT. LOT - NIGHT", castRemoved: ["MAYA", "JERRY"] }], revision: { label: "Blue", color: "blue" } };
  const groups = planGroups(plan, "add");
  assert.deepEqual(groups.map(g => g.key), ["headingChanged", "pagesChanged", "castRemoved", "matched"]);
  assert.deepEqual(groups[0]!.rows, ["2 · EXT. CUL-DE-SAC - NIGHT: was EXT. STREET - NIGHT"]);
  assert.deepEqual(groups[1]!.rows, ["3 · INT. TRUCK - NIGHT: 1 1/8 → 4/8 pages"]);
  assert.match(groups[2]!.title, /kept/);
  assert.match(planGroups(plan, "sync")[2]!.title, /removes/);
  assert.deepEqual(groups[2]!.rows, ["4 · EXT. LOT - NIGHT: − MAYA, JERRY"]);
});
