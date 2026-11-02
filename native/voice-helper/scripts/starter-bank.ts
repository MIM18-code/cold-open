import { resolve, join } from "node:path";
import { ReaderRuntime } from "../../../apps/desktop/src/main/tts/runtime.ts";
import { VoiceModelManager } from "../../../apps/desktop/src/main/models/voice-manager.ts";
import { VOICE_PACKS } from "../../../apps/desktop/src/main/models/voice-manifest.ts";
import { ReferenceBank } from "../../../apps/desktop/src/main/tts/reference-bank.ts";
import { STARTER_TRANSCRIPT, STARTER_VOICES } from "./starter-voices.ts";

const args = process.argv.slice(2);
const dataIndex = args.indexOf("--data-dir");
if (dataIndex < 0 || !args[dataIndex + 1]) throw new Error("Usage: npm run voices:starter-bank -- --data-dir <app userData> [--helper <binary>]");
const root = resolve(args[dataIndex + 1]!);
const helperIndex = args.indexOf("--helper");
const helper = helperIndex < 0 ? resolve("native/voice-helper/.build/release/voice-helper") : resolve(args[helperIndex + 1]!);
const models = new VoiceModelManager(join(root, "voice-models"), VOICE_PACKS);
const references = new ReferenceBank(join(root, "voice-references"));
// This script only renders. Install the optional pack through the app with consent first.
await models.verifiedDirectory("qwen-design");
const runtime = new ReaderRuntime({ root: join(root, "table-read-cache"), helper, models, references });
const existing = await references.list();
try {
  for (const [label, description, tags] of STARTER_VOICES) {
    if (existing.some((v) => v.label === label && v.description === description && v.transcript === STARTER_TRANSCRIPT)) continue;
    const voice = await runtime.designVoice({ label, description, transcript: STARTER_TRANSCRIPT, tags: [...tags],
      provenance: "Cold Open starter-bank recipe v1. Synthetic VoiceDesign reference; no real person's recording. Requires listening and rights review before redistribution." });
    process.stdout.write(`${label}: ${voice.id}\n`);
  }
} finally { runtime.dispose(); }
