import assert from "node:assert/strict";
import test from "node:test";
import { visiblePanelTabs } from "../src/renderer/shell/panel-tabs.ts";

test("tabs need no overflow control when every label fits", () => {
  assert.deepEqual(visiblePanelTabs([50, 60, 70], 2, 184, 60), [0, 1, 2]);
});

test("overflow reserves More and brings the active panel into the row", () => {
  const widths = [50, 60, 70, 90, 80, 40, 100, 60];
  const visible = visiblePanelTabs(widths, 7, 280, 60);
  assert.deepEqual(visible, [0, 1, 7]);
  assert(widths.filter((_, index) => visible.includes(index)).reduce((sum, width) => sum + width, 0)
    + 60 + visible.length * 2 <= 280);
  assert.deepEqual(visiblePanelTabs(widths, 6, 160, 50), [6]);
});
