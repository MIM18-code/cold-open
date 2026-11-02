// Co-writers' windows moving scenes, typing, undoing and redoing at once, with each change passed on as it is
// made (as the relay and folder sync do): every window ends with the same script, no paragraph ID twice.
import assert from "node:assert/strict";
import { test } from "node:test";

import { ScreenplayDoc, moveScene, parseFountain, plainText } from "@screenplay/engine";

import { DocumentSession } from "../src/renderer/core/session.ts";

const SCRIPT = "INT. A - DAY\n\nAlpha.\n\nINT. B - DAY\n\nBravo.\n\nINT. C - DAY\n\nCharlie.\n\nINT. D - DAY\n\nDelta.\n";
const NET = "net";

function rng(seed: number) { return () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296; }

/** Paragraph IDs that appear more than once. */
const repeated = (doc: ScreenplayDoc) => doc.validate().filter((problem) => / repeats ID /.test(problem));

test("windows moving, typing, undoing and redoing at once converge with every paragraph ID once", () => {
  for (let seed = 1; seed <= 150; seed++) {
    const r = rng(seed);
    const base = ScreenplayDoc.fromScript(parseFountain(SCRIPT));
    const sessions = [0, 1, 2].map(() => {
      const s = new DocumentSession(ScreenplayDoc.fromUpdate(base.encodeState()));
      s.undo.clear();
      return s;
    });
    const queues = sessions.map(() => [] as Uint8Array[]);
    sessions.forEach((s, i) => s.doc.ydoc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== NET) queues.forEach((queue, j) => j !== i && queue.push(update));
    }));
    const deliver = (j: number, count: number) => {
      for (let k = 0; k < count && queues[j]!.length; k++) sessions[j]!.doc.applyUpdate(queues[j]!.shift()!, NET);
    };
    for (let step = 0; step < 30; step++) {
      const s = sessions[Math.floor(r() * 3)]!;
      const roll = r();
      if (roll < 0.3) {
        const scenes = s.doc.scenes();
        const pick = scenes[Math.floor(r() * scenes.length)]!;
        const anchor = r() < 0.3 ? null : scenes[Math.floor(r() * scenes.length)]!.sceneId;
        try {
          s.edit(() => moveScene(s.doc, pick.sceneId, anchor));
        } catch {
          // The anchor was inside the scene: nothing moved.
        }
      } else if (roll < 0.55) {
        const paragraphs = s.doc.paragraphs();
        const p = paragraphs[1 + Math.floor(r() * (paragraphs.length - 1))]!;
        if (p.id) s.edit(() => s.doc.insertText(p.id, Math.min(2, plainText(p.runs).length), `x${step}`));
      } else if (roll < 0.7) {
        s.undo.stopCapturing();
        s.undo.undo();
      } else if (roll < 0.78) {
        s.undo.redo();
      } else {
        deliver(Math.floor(r() * 3), 1 + Math.floor(r() * 4));
      }
      for (const x of sessions) assert.deepEqual(repeated(x.doc), [], `seed ${seed} step ${step}`);
    }
    for (let round = 0; round < 10; round++) for (let j = 0; j < 3; j++) deliver(j, 1000);
    const scripts = sessions.map((s) => JSON.stringify(s.doc.toScript().paragraphs));
    assert.equal(scripts[1], scripts[0], `seed ${seed}`);
    assert.equal(scripts[2], scripts[0], `seed ${seed}`);
    // The paragraph list each window keeps matches a fresh read of its document.
    assert.equal(JSON.stringify(ScreenplayDoc.fromUpdate(sessions[0]!.doc.encodeState()).toScript().paragraphs), scripts[0], `seed ${seed}`);
  }
});
