// Sidecar files and portable-bundle voice assets. The script path must already be granted (the writer opened it
// or chose it in a dialog); the sidecar is then derived from it, so a page can never name a sidecar somewhere else.
import { join } from "node:path";

import {
  MAX_REFERENCE_ASSET_BYTES, MAX_SIDECAR_BYTES, TABLE_READ, type ShareableReference,
} from "../../shared/channels/table-read.ts";
import type { ServiceContext } from "../context.ts";
import { ReferenceBank } from "../tts/reference-bank.ts";
import {
  importReferences, isScriptPath, readSidecar, shareableReferences, writeSidecar,
} from "../table-read-sidecar.ts";

const REFERENCE_ID = /^[a-z0-9-]{1,80}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function decodeAudio(value: unknown): Uint8Array {
  if (typeof value !== "string" || !value || value.length % 4 !== 0 || !BASE64.test(value)) throw new Error("Invalid reference audio.");
  // Check the decoded size before allocating it; a base64 string cannot expand beyond this.
  const bytes = (value.length / 4) * 3 - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0);
  if (bytes > MAX_REFERENCE_ASSET_BYTES) throw new Error("Reference audio exceeds the size limit.");
  return new Uint8Array(Buffer.from(value, "base64"));
}

export function register(ctx: ServiceContext): void {
  const references = new ReferenceBank(join(ctx.paths.userData, "voice-references"));

  ctx.handle(TABLE_READ.readSidecar, async (_event, scriptPath: unknown) => {
    if (typeof scriptPath !== "string" || !isScriptPath(scriptPath) || !ctx.isAllowedPath(scriptPath)) {
      throw new Error("That script was not opened through the app. Open it again before restoring its table read.");
    }
    return readSidecar(scriptPath);
  });

  ctx.handle(TABLE_READ.writeSidecar, async (_event, scriptPath: unknown, text: unknown) => {
    if (typeof scriptPath !== "string" || !isScriptPath(scriptPath) || !ctx.isAllowedPath(scriptPath)) {
      throw new Error("Open the FDX or Fountain script before saving table-read data next to it.");
    }
    if (typeof text !== "string" || text.length > MAX_SIDECAR_BYTES) throw new Error("Invalid table-read file.");
    return writeSidecar(scriptPath, text);
  });

  ctx.handle(TABLE_READ.shareableReferences, async (_event, ids: unknown) => {
    if (!Array.isArray(ids) || ids.length > 32 || ids.some((id) => typeof id !== "string" || !REFERENCE_ID.test(id))) {
      throw new Error("Invalid reference voice list.");
    }
    return shareableReferences(references, ids as string[]);
  });

  ctx.handle(TABLE_READ.importReferences, async (_event, input: unknown) => {
    if (!Array.isArray(input) || input.length > 32) throw new Error("Too many reference voices in this bundle.");
    const entries: (ShareableReference & { audioBytes: Uint8Array })[] = input.map((raw) => {
      const entry = raw as (Partial<ShareableReference> & { shareable?: boolean }) | null;
      if (!entry || typeof entry !== "object" || entry.engine !== "qwen" || entry.shareable !== true
        || typeof entry.id !== "string" || !REFERENCE_ID.test(entry.id)
        || typeof entry.label !== "string" || typeof entry.transcript !== "string" || typeof entry.description !== "string"
        || !Array.isArray(entry.tags) || entry.tags.some((tag) => typeof tag !== "string")
        || typeof entry.provenance !== "string" || typeof entry.generatorVersion !== "string"
        || typeof entry.modelChecksum !== "string" || typeof entry.audioChecksum !== "string") {
        throw new Error("Invalid reference voice in this bundle.");
      }
      return { ...(entry as ShareableReference), audioBytes: decodeAudio(entry.audio) };
    });
    const saved = await importReferences(references, entries);
    return Object.fromEntries(saved.map((item) => [item.oldId, item.newId]));
  });
}
