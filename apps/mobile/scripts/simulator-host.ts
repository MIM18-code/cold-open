// Start the actual paired services with a synthetic screenplay, without opening a writer's document.
import { writeFile, unlink } from "node:fs/promises";
import { ScreenplayDoc, parseFountain, plainText, productionChanges, setRevisionState } from "@screenplay/engine";
import { PhoneServer } from "../../desktop/src/main/phone/server.ts";
import { publishToPhone } from "../../desktop/src/renderer/features/phone/publisher.ts";

const file = process.argv[2];
if (!file) throw new Error("Pass a private temporary path for the pairing code.");
const doc = ScreenplayDoc.fromScript(parseFountain(`INT. FERRY TERMINAL - DAWN

An empty ticket booth. A paper timetable stirs against the glass.

NORA sets a thermos on the counter. Two cups, both chipped.

NORA
You kept the light on.

ELI
Last boat hasn't come in.

Beyond the window, a single lamp crosses the water.

EXT. FERRY LANDING - DAWN

A rope drops onto the wet boards.`));
// A small Blue revision, so Changes and the revision marks can be checked in the simulator. A real Mac always sends one.
const baseline = structuredClone([...doc.paragraphs()]);
const revised = doc.paragraphs().find(p => plainText(p.runs).startsWith("Last boat"))!;
setRevisionState(doc, { sets: [{ id: "1", name: "Blue", color: "#4a90d9", mark: "*", date: "11/03/26", style: "" }],
  currentSetId: "1", tracking: true, showMarks: true });
doc.formatRuns(revised.id, 0, plainText(revised.runs).length, { "fdx:RevisionID": "1" });
const production = productionChanges(doc, baseline);
const server = new PhoneServer({ title: "The Last Crossing", revision: "r1", cues: [], production });
const info = await server.start("127.0.0.1");
const point = { paragraphId: doc.paragraphs()[1]!.id, offset: 0 };
const host = publishToPhone(info.publisher, doc, () => ({
  title: "The Last Crossing", name: "Mara", writers: [], cursor: { anchor: point, head: point }, production,
}));
await writeFile(file, info.pairing, { mode: 0o600, flag: "wx" });
console.log(`Pairing code written to ${file}. Paste it on the Pair screen (Paste a pairing code).`);
async function close() { host.stop(); await server.stop(); doc.ydoc.destroy(); await unlink(file); process.exit(); }
process.on("SIGTERM", close);
process.on("SIGINT", close);
