import assert from "node:assert/strict";
import test from "node:test";
import { confirmResponse } from "../src/renderer/core/message-box.ts";

test("browser Cancel picks the message box's cancel button, OK the action", () => {
  // Safe choice first, as the destructive confirmations are written.
  assert.equal(confirmResponse(["Keep", "Discard"], 0, false), 0);
  assert.equal(confirmResponse(["Keep", "Discard"], 0, true), 1);
  // Action first with a trailing Cancel.
  assert.equal(confirmResponse(["Use system fonts", "Cancel"], 1, true), 0);
  assert.equal(confirmResponse(["Use system fonts", "Cancel"], 1, false), 1);
  // No cancelId: the last button cancels, as before.
  assert.equal(confirmResponse(["Save", "Don't Save", "Cancel"], undefined, false), 2);
  assert.equal(confirmResponse(["Save", "Don't Save", "Cancel"], undefined, true), 0);
});
