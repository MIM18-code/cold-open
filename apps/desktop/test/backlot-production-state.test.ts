import test from "node:test";
import assert from "node:assert/strict";
import { reviewForChange } from "../src/shared/channels/backlot.ts";
import { productionSnapshot, backlotChanges } from "@screenplay/engine";
import { productionState } from "../src/main/ai/backlot.ts";

test("production flags use imported paragraph IDs and issued day breaks, including trailing scheduled strips", () => {
  const result = productionState({ id: "project", script: { scenes: [
    { id: "production-a", scriptKey: { paragraphId: "heading-a" } },
    { id: "production-b", scriptKey: { paragraphId: "heading-b" } },
    { id: "production-c" },
  ] }, schedule: { items: [
    { kind: "strip", sceneId: "production-a" }, { kind: "dayBreak", id: "day-a" },
    { kind: "strip", sceneId: "production-b" },
  ] }, callSheets: [{ dayBreakId: "day-a", issues: [{ issuedAt: "2026-11-01" }] }] });
  assert.deepEqual(result.scenes, [
    { sceneId: "production-a", headingId: "heading-a", scheduled: true, issuedCallSheet: true },
    { sceneId: "production-b", headingId: "heading-b", scheduled: true, issuedCallSheet: false },
    { sceneId: "production-c", scheduled: false, issuedCallSheet: false },
  ]);
  assert.deepEqual(productionState({ id: "p", script: { scenes: [{ id: "a" }] }, callSheets: [{ dayBreakId: "day", issues: [] }] }).scenes,
    [{ sceneId: "a", scheduled: false, issuedCallSheet: false }]);
  assert.throws(() => productionState({}), /not a Backlot/);
});

test("review flags retain the original heading identity after an omission replaces it", () => {
  const old = productionSnapshot({ titlePage: [], paragraphs: [{ id: "old-heading", sceneId: "stable-scene", type: "sceneHeading", runs: [{ text: "INT. ROOM - DAY" }] }] });
  const current = structuredClone(old);
  current.scenes[0]!.headingId = "omission-heading";
  current.scenes[0]!.omitted = true;
  const change = backlotChanges({ ...old, sentAt: "2026-11-01", projectId: "project" }, current).scenes[0]!;
  assert.deepEqual(reviewForChange({ projectId: "project", scenes: [{ sceneId: "production-scene", headingId: "old-heading", scheduled: true, issuedCallSheet: true }] }, change),
    { scheduled: true, issuedCallSheet: true, needsBacklotReview: true });
});

for (const number of ["2", "2A", "", undefined]) test(`review flags follow an explicit match for incoming scene ${number || "without a number"}`, () => {
  const current = productionSnapshot({ titlePage: [], paragraphs: [{ id: "incoming-heading", sceneId: "incoming-scene", sceneNumber: number,
    type: "sceneHeading", runs: [{ text: "INT. ROOM - DAY" }] }] });
  const change = backlotChanges(null, current).scenes[0]!;
  const state = { projectId: "project", scenes: [{ sceneId: "scheduled-scene", headingId: "different-heading", scheduled: true, issuedCallSheet: true }] };
  assert.deepEqual(reviewForChange(state, change, [{ incomingNumber: number || "1", action: "match", sceneId: "scheduled-scene" }]),
    { scheduled: true, issuedCallSheet: true, needsBacklotReview: true });
  assert.deepEqual(reviewForChange(state, change, [{ incomingNumber: number || "1", action: "new" }]),
    { scheduled: false, issuedCallSheet: false, needsBacklotReview: false });
});
