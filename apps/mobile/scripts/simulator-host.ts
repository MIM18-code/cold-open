// Start the actual paired services with a synthetic screenplay, without opening a writer's document.
import { writeFile, unlink } from "node:fs/promises";
import { ScreenplayDoc, parseFountain } from "@screenplay/engine";
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
const server = new PhoneServer({ title: "The Last Crossing", revision: "r1", cues: [] });
const info = await server.start("127.0.0.1");
const point = { paragraphId: doc.paragraphs()[1]!.id, offset: 0 };
const host = publishToPhone(info.publisher, doc, () => ({
  title: "The Last Crossing", name: "Mara", writers: [], cursor: { anchor: point, head: point },
}));
await writeFile(file, info.pairing, { mode: 0o600, flag: "wx" });
async function close() { host.stop(); await server.stop(); doc.ydoc.destroy(); await unlink(file); process.exit(); }
process.on("SIGTERM", close);
process.on("SIGINT", close);
