// The file beside an FDX or Fountain script that carries table-read data, and the reference voices a portable
// bundle may share. No Electron and no renderer here, so tests drive the rules directly.
//
// The sidecar is `<script>.coldopen-read.json`: next to the script, named after it, versioned on its own. Reading
// refuses a link in its last path component and a file that is not regular (safe-fs). Writing uses a random
// temporary name and a rename, so a link planted at the sidecar's name is replaced rather than written through.
import { createHash, randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { basename, resolve } from "node:path";

import {
  LEGACY_SIDECAR_SUFFIX, MAX_REFERENCE_ASSET_BYTES, MAX_SIDECAR_BYTES, SIDECAR_SUFFIX, type ShareableReference,
} from "../shared/channels/table-read.ts";
import type { VoiceReference } from "./tts/reference-bank.ts";
import { ReferenceBank } from "./tts/reference-bank.ts";
import { openForRead, randomSuffix, replaceFile } from "./safe-fs.ts";

export { LEGACY_SIDECAR_SUFFIX, SIDECAR_SUFFIX };
export const MAX_SHARED_AUDIO_BYTES = 48 * 1024 * 1024;

const SCRIPT_EXTENSIONS = /\.(fdx|fountain)$/i;
const REFERENCE_ID = /^[a-z0-9-]{1,80}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export function isScriptPath(path: string): boolean {
  return SCRIPT_EXTENSIONS.test(path) && !path.endsWith(SIDECAR_SUFFIX) && !path.endsWith(LEGACY_SIDECAR_SUFFIX);
}

/** `<script name>.coldopen-read.json`, in the same folder as the script. */
export function sidecarPathFor(scriptPath: string): string {
  if (!isScriptPath(scriptPath)) throw new Error("A table-read file sits next to an FDX or Fountain script.");
  return resolve(scriptPath) + SIDECAR_SUFFIX;
}

/** `<script name>.inklot-read.json`, the name used before the app became Cold Open. */
export function legacySidecarPathFor(scriptPath: string): string {
  return sidecarPathFor(scriptPath).slice(0, -SIDECAR_SUFFIX.length) + LEGACY_SIDECAR_SUFFIX;
}

/**
 * Read the sidecar beside a script. Null when there is none. A link is refused, never followed. A script with only
 * an old-named sidecar reads that one; when both exist the current name wins.
 */
export async function readSidecar(scriptPath: string): Promise<string | null> {
  const current = sidecarPathFor(scriptPath);
  let path = current;
  let opened = await openForRead(path);
  if (!opened) {
    path = legacySidecarPathFor(scriptPath);
    opened = await openForRead(path);
  }
  if (!opened) return null;
  try {
    if (opened.info.size > MAX_SIDECAR_BYTES) throw new Error(`${basename(path)} exceeds its size limit.`);
    return new TextDecoder().decode(await opened.read(MAX_SIDECAR_BYTES));
  } finally {
    await opened.close();
  }
}

/** Replace the sidecar atomically. The caller has already checked that the script path is granted. */
export async function writeSidecar(scriptPath: string, text: string): Promise<{ path: string; hash: string }> {
  if (typeof text !== "string" || !text.trim()) throw new Error("The table-read file is empty.");
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > MAX_SIDECAR_BYTES) throw new Error("The table-read file is too large.");
  const path = sidecarPathFor(scriptPath);
  await replaceFile(path, `${path}.saving-${process.pid}-${randomSuffix()}`, text);
  // The new sidecar now holds everything; a leftover old one would come back as stale data if this one went missing.
  await rm(legacySidecarPathFor(scriptPath), { force: true });
  return { path, hash: createHash("sha256").update(bytes).digest("hex") };
}

/**
 * Describes whether a reference's provenance permits sharing. Only designed voices made by the Cold Open starter
 * bank travel, and only while their provenance does not forbid it. A recording of a real person, a film rip or
 * any voice marked private stays on the machine that made it.
 */
export function isShareableProvenance(provenance: string): boolean {
  if (typeof provenance !== "string" || !provenance.trim()) return false;
  if (/(non[- ]?shareable|not shareable|do not share|do not redistribute|private|confidential)/i.test(provenance)) return false;
  return /starter[- ]bank|voice ?design(ed)? (reference|voice)/i.test(provenance);
}

function checkedReference(id: string): string {
  if (!REFERENCE_ID.test(id)) throw new Error("Invalid reference voice ID.");
  return id;
}

/** The shareable reference voices among `ids`, with their audio as base64. Missing or unverifiable ones are skipped. */
export async function shareableReferences(bank: ReferenceBank, ids: readonly string[]): Promise<ShareableReference[]> {
  if (!Array.isArray(ids) || ids.length > 32) throw new Error("Choose at most 32 reference voices to share.");
  const out: ShareableReference[] = [];
  let total = 0;
  for (const raw of [...new Set(ids)]) {
    const id = checkedReference(raw);
    let entry: { reference: VoiceReference; audioPath: string };
    try {
      entry = await bank.get(id);
    } catch {
      continue;
    }
    if (!isShareableProvenance(entry.reference.provenance)) continue;
    const audio = await readFile(entry.audioPath);
    if (audio.length > MAX_REFERENCE_ASSET_BYTES || !archiveMatches(audio, entry.reference.audioChecksum)) continue;
    if (total + audio.length > MAX_SHARED_AUDIO_BYTES) throw new Error("The reference voices exceed the shared audio limit.");
    total += audio.length;
    out.push({ ...entry.reference, engine: "qwen", audio: audio.toString("base64"), shareable: true });
  }
  return out;
}

function archiveMatches(audio: Uint8Array, checksum: string): boolean {
  return SHA256.test(checksum) && createHash("sha256").update(audio).digest("hex") === checksum;
}

export interface ImportedReference {
  oldId: string;
  newId: string;
}

/**
 * Save shareable reference audio from a bundle into the local bank. A voice already present with the same audio
 * keeps its ID, so imported cast bindings still resolve. A different voice under the same ID is saved under a new
 * ID; the caller remaps the cast to it. Nothing here overwrites an accepted voice.
 */
export async function importReferences(
  bank: ReferenceBank, entries: readonly (ShareableReference & { audioBytes: Uint8Array })[],
): Promise<ImportedReference[]> {
  if (!Array.isArray(entries) || entries.length > 32) throw new Error("Too many reference voices.");
  const out: ImportedReference[] = [];
  let total = 0;
  for (const entry of entries) {
    const oldId = checkedReference(entry.id);
    if (!isShareableProvenance(entry.provenance)) throw new Error("This voice's provenance does not allow sharing.");
    if (!Array.isArray(entry.tags) || entry.tags.length > 20 || entry.tags.some((tag: unknown) => typeof tag !== "string" || tag.length > 100)
      || typeof entry.label !== "string" || !entry.label.trim() || entry.label.length > 100
      || typeof entry.transcript !== "string" || !entry.transcript.trim() || entry.transcript.length > 1000
      || typeof entry.description !== "string" || entry.description.length > 1000
      || typeof entry.generatorVersion !== "string" || !entry.generatorVersion || entry.generatorVersion.length > 200
      || typeof entry.modelChecksum !== "string" || !entry.modelChecksum || entry.modelChecksum.length > 200
      || entry.audioBytes.length > MAX_REFERENCE_ASSET_BYTES || entry.audioBytes.length < 44) {
      throw new Error("Invalid reference voice in this bundle.");
    }
    if (!archiveMatches(entry.audioBytes, entry.audioChecksum)) throw new Error("Reference voice audio does not match its checksum.");
    total += entry.audioBytes.length;
    if (total > MAX_SHARED_AUDIO_BYTES) throw new Error("The reference voices exceed the shared audio limit.");
    let existing: { reference: VoiceReference } | null = null;
    try { existing = await bank.get(oldId); } catch { existing = null; }
    if (existing?.reference.audioChecksum === entry.audioChecksum) {
      out.push({ oldId, newId: oldId });
      continue;
    }
    if (!existing) {
      // Keep the designed voice's identity when this Mac does not have it yet, so imports are repeatable.
      try {
        await bank.save({
          id: oldId, label: entry.label, transcript: entry.transcript, description: entry.description,
          tags: [...entry.tags], provenance: entry.provenance, generatorVersion: entry.generatorVersion,
          modelChecksum: entry.modelChecksum,
        }, entry.audioBytes);
        out.push({ oldId, newId: oldId });
        continue;
      } catch { /* The ID is taken by an invalid or different reference; save under a new one. */ }
    }
    const newId = randomUUID();
    await bank.save({
      id: newId, label: entry.label, transcript: entry.transcript, description: entry.description,
      tags: [...entry.tags], provenance: entry.provenance, generatorVersion: entry.generatorVersion,
      modelChecksum: entry.modelChecksum,
    }, entry.audioBytes);
    out.push({ oldId, newId });
  }
  return out;
}
