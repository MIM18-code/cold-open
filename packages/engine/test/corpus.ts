// Round-trip check over real FDX files that must never be committed. Pass a file listing one FDX
// path per line:  npm run corpus -- ~/fdx-list.txt
// Prints only counts and the first difference per failing file, never script text beyond that.
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

import { ScreenplayDoc, parseFdx, parseFountain, plainText, writeFdx, writeFountain } from "../src/index.ts";
import type { Script } from "../src/model.ts";
import { parseXml } from "../src/xml.ts";
import { canonical, firstDifference } from "./canonical.ts";

const list = process.argv[2];
if (!list) throw new Error("Usage: node test/corpus.ts <file listing FDX paths>");
const paths = readFileSync(list, "utf8").split("\n").map((line) => line.trim()).filter(Boolean);

const words = (script: Script) => script.paragraphs.flatMap((p) => plainText(p.runs).split(/\s+/)).filter(Boolean).join(" ");
const tally = { files: 0, fdxExact: 0, repaired: 0, crdtExact: 0, fountainStable: 0, fountainWords: 0, idsKept: 0, ids: 0, paragraphs: 0, ms: 0 };
const failures: string[] = [];

for (const path of paths) {
  tally.files++;
  const short = path.replace(/^.*\//, "");
  try {
    const source = readFileSync(path, "utf8");
    const started = performance.now();
    const warnings: string[] = [];
    const script = parseFdx(source, { warnings });
    const viaDoc = ScreenplayDoc.fromUpdate(ScreenplayDoc.fromScript(script).encodeState()).toScript();
    const written = writeFdx(viaDoc);
    tally.ms += performance.now() - started;
    tally.paragraphs += script.paragraphs.length;

    if (isDeepStrictEqual(viaDoc, script)) tally.crdtExact++;
    else failures.push(`${short}: CRDT changed the script`);

    const difference = firstDifference(canonical(parseXml(written), { ignoreIds: true }), canonical(parseXml(source), { ignoreIds: true }));
    // Invalid files are repaired on import, so they cannot match byte for byte.
    if (!difference) tally.fdxExact++;
    else if (warnings.length) tally.repaired++;
    else failures.push(`${short}: FDX ${difference.slice(0, 300)}`);

    const original = [...source.matchAll(/<Paragraph\b[^>]*?\s(?:id|Id|ID)="([^"]+)"/g)].map((m) => m[1]);
    const kept = new Set([...written.matchAll(/<Paragraph\b[^>]*?\s(?:id|Id|ID)="([^"]+)"/g)].map((m) => m[1]));
    tally.ids += original.length;
    tally.idsKept += original.filter((id) => kept.has(id)).length;

    const fountain = writeFountain(script);
    const back = parseFountain(fountain);
    if (writeFountain(back) === fountain) tally.fountainStable++;
    else failures.push(`${short}: Fountain output changed on a second pass`);
    if (words(back) === words(script)) tally.fountainWords++;
    else failures.push(`${short}: Fountain lost or changed words`);
  } catch (error) {
    failures.push(`${short}: threw ${(error as Error).message}`);
  }
}

console.log(JSON.stringify({ ...tally, ms: Math.round(tally.ms) }, null, 2));
for (const failure of failures.slice(0, 40)) console.log(failure);
if (failures.length > 40) console.log(`...and ${failures.length - 40} more`);
process.exitCode = failures.length ? 1 : 0;
