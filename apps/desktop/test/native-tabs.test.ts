import assert from "node:assert/strict";
import { test } from "node:test";
import { attachDocumentTab, performTabAction, type TabWindow } from "../src/main/native-tabs.ts";
function fake() {
  const calls: string[] = [];
  const window: TabWindow = { isDestroyed: () => false, addTabbedWindow: () => { calls.push("attach"); }, selectNextTab: () => { calls.push("next"); }, selectPreviousTab: () => { calls.push("previous"); }, toggleTabBar: () => { calls.push("toggle"); }, mergeAllWindows: () => { calls.push("merge"); }, moveTabToNewWindow: () => { calls.push("detach"); } };
  return { window, calls };
}
test("native tabs attach only on macOS to a living, different parent", () => {
  const a = fake(), b = fake();
  assert.equal(attachDocumentTab("linux", a.window, b.window), false);
  assert.equal(attachDocumentTab("darwin", a.window, a.window), false);
  assert.equal(attachDocumentTab("darwin", undefined, b.window), false);
  assert.equal(attachDocumentTab("darwin", a.window, b.window), true);
  a.window.isDestroyed = () => true;
  assert.equal(attachDocumentTab("darwin", a.window, b.window), false);
  assert.deepEqual(a.calls, ["attach"]);
});
test("tab actions are allowlisted; arbitrary IPC cannot invoke window methods", () => {
  const a = fake();
  for (const action of ["next", "previous", "toggle", "merge", "detach"]) performTabAction("darwin", a.window, action);
  assert.deepEqual(a.calls, ["next", "previous", "toggle", "merge", "detach"]);
  assert.throws(() => performTabAction("darwin", a.window, "close"), /Unknown/);
  performTabAction("linux", a.window, "next"); performTabAction("darwin", null, "next");
  assert.equal(a.calls.length, 5);
});
