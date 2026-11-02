// Replays every input the Writers Block Python test suite fed its formatting
// rules (recorded by test/parity/record_cases.py) and requires identical output.
// PARITY_CASES=path adds another expected file, e.g. private real takes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parseProposalObject } from "../src/models.ts";
import {
  audit, automaticInsertionErrors, capitalizeIntroductions, droppedSpeech, dropUnanchoredOmissions,
  normalizeProposal, parseProposal, pasteNotes, shortcutErrors, sourceErrors, spokenHeading, structureDiagnostics,
} from "../src/validation.ts";

type Outcome = { ok?: unknown; error?: string };

function safe(fn: () => unknown): Outcome {
  try {
    return { ok: fn() };
  } catch (error) {
    return { error: (error as Error).name };
  }
}

/** Python only records that it raised; the port only has to raise too. */
function same(actual: Outcome, expected: Outcome, label: string): void {
  if ("error" in expected) assert.ok("error" in actual, `${label}: Python raised, TypeScript returned`);
  else assert.deepEqual(actual.ok, expected.ok, label);
}

function proposalOutputs(raw: unknown, transcript: string): Record<string, unknown> {
  let proposal;
  try {
    proposal = parseProposalObject(raw);
  } catch {
    return { invalid: true };
  }
  const p = proposal;
  const out: Record<string, unknown> = {
    structure: structureDiagnostics(p.elements),
    source_errors: sourceErrors(p, transcript),
    audit: safe(() => audit(p, transcript)),
    shortcut_errors: safe(() => shortcutErrors(p, transcript)),
    automatic: safe(() => automaticInsertionErrors(p, transcript)),
    paste_notes: safe(() => pasteNotes(p, transcript)),
    dropped_speech: safe(() => droppedSpeech(p, transcript).toObject()),
    drop_unanchored: safe(() => dropUnanchoredOmissions(p, transcript)),
    normalize: safe(() => normalizeProposal(p, transcript)),
  };
  const normalized = (out.normalize as Outcome).ok as ReturnType<typeof normalizeProposal> | undefined;
  if (normalized) {
    out.normalized_audit = safe(() => audit(normalized, transcript));
    out.normalized_automatic = safe(() => automaticInsertionErrors(normalized, transcript));
    out.normalized_strict = safe(() => automaticInsertionErrors(normalized, transcript, { strict: true }));
    out.normalized_paste_notes = safe(() => pasteNotes(normalized, transcript));
  }
  return out;
}

const files = [fileURLToPath(new URL("./parity/cases.json", import.meta.url))];
if (process.env.PARITY_CASES) files.push(process.env.PARITY_CASES);

for (const file of files) {
  const cases = JSON.parse(readFileSync(file, "utf8")) as Array<Record<string, any>>;
  test(`parity with Writers Block: ${cases.length} cases from ${file.split("/").at(-1)}`, () => {
    let failures = 0;
    const messages: string[] = [];
    cases.forEach((c, i) => {
      try {
        if (c.kind === "heading") {
          assert.equal(spokenHeading(c.quote), c.expected, "spokenHeading");
        } else if (c.kind === "parse") {
          same(safe(() => parseProposal(c.raw)), c.expected, "parseProposal");
        } else if (c.kind === "capitalize") {
          assert.deepEqual(capitalizeIntroductions(parseProposalObject(c.proposal), c.cast, c.introduced), c.expected);
        } else {
          const actual = proposalOutputs(c.proposal, c.transcript);
          if ("invalid" in c.expected) {
            assert.ok("invalid" in actual, "Python rejected the proposal");
            return;
          }
          for (const [key, expected] of Object.entries(c.expected)) {
            const value = actual[key];
            if (expected && typeof expected === "object" && ("ok" in expected || "error" in expected)) {
              same(value as Outcome, expected as Outcome, key);
            } else {
              assert.deepEqual(value, expected, key);
            }
          }
        }
      } catch (error) {
        failures++;
        if (messages.length < 5) messages.push(`case ${i} (${c.kind}): ${(error as Error).message.slice(0, 1500)}`);
      }
    });
    assert.equal(failures, 0, `${failures} of ${cases.length} cases differ\n` + messages.join("\n\n"));
  });
}
