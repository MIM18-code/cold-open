// A portable table read: one `.coldopenread` JSON file with the source manifest, cast, pronunciations, listening
// notes and the reference voices whose provenance allows them to travel. A plain JSON container is used
// deliberately: there is no archive to extract, so import never writes to a path named by the file. Import still
// bounds every entry and the total, refuses non-WAV payloads (which also refuses a zip or gzip pretending to be
// audio), and validates every field before anything reaches the document.
import type { ShareableReference } from "../../../shared/channels/table-read.ts";
import {
  parseSidecar,
  type ApplyResult, type RestoreProps, type SidecarMatch, type TableReadSidecar,
} from "./sidecar.ts";

// The format string is stored inside every bundle, so it keeps the old app name; changing it would orphan old bundles.
export const BUNDLE_FORMAT = "inklot.read-bundle";
export const BUNDLE_EXTENSION = "coldopenread";
/** Bundles exported before the rename. Importing accepts them; exporting never writes them. */
export const LEGACY_BUNDLE_EXTENSION = "inklotread";
export const BUNDLE_IMPORT_EXTENSIONS = [BUNDLE_EXTENSION, LEGACY_BUNDLE_EXTENSION];
export const BUNDLE_VERSION = 1;
export const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
export const MAX_REFERENCE_BYTES = 16 * 1024 * 1024;
export const MAX_RENDERED_BYTES = 32 * 1024 * 1024;
export const MAX_TOTAL_ASSET_BYTES = 48 * 1024 * 1024;
export const MAX_BUNDLE_ENTRIES = 32;

export interface BundleReference extends ShareableReference { shareable: true }
export interface BundleAudio { name: string; mime: "audio/wav"; audio: string; }
export interface TableReadBundle {
  format: "inklot.read-bundle";
  version: 1;
  project: TableReadSidecar;
  references: BundleReference[];
  rendered: BundleAudio[];
}
export interface BundleRestoreProps extends RestoreProps {
  bundle: TableReadBundle;
  match: SidecarMatch;
}
export interface BundleApplyResult extends ApplyResult {
  references: number;
  referenceWarning?: string;
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const REFERENCE_ID = /^[a-z0-9-]{1,80}$/;
const AUDIO_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,80}$/;
const WAV_BASE64 = "UklGR";

function keysOf(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown field "${key}" in this ${where}.`);
}

/** Bytes a base64 string decodes to, checked before any allocation. */
export function decodedBytes(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function audioOf(value: unknown, limit: number, where: string): string {
  if (typeof value !== "string" || !value || value.length % 4 !== 0 || !BASE64.test(value)) throw new Error(`Invalid ${where} audio.`);
  if (!value.startsWith(WAV_BASE64)) throw new Error(`${where} audio must be WAV.`);
  if (decodedBytes(value) < 44) throw new Error(`${where} audio must be WAV.`);
  if (decodedBytes(value) > limit) throw new Error(`${where} audio exceeds the size limit.`);
  return value;
}

function stringOf(value: unknown, limit: number, where: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit) throw new Error(`Invalid ${where}.`);
  return value;
}

function audioName(value: unknown): string {
  if (typeof value !== "string" || !AUDIO_NAME.test(value) || value.includes("..") || /[/\\]/.test(value)) {
    throw new Error("Invalid audio name in this bundle.");
  }
  return value;
}

/** Provenance and descriptions are free text from a local voice record; a machine path is not bundle material. */
export function redactLocalPaths(value: string): string {
  return value.replace(/(?:\/Users\/|\/home\/|\/private\/|\/Volumes\/|[A-Za-z]:\\)[^\s,;:)]*/g, "[local path]");
}

function parseReference(value: unknown): BundleReference {
  if (!object(value)) throw new Error("Invalid reference voice in this bundle.");
  keysOf(value, ["id", "engine", "label", "transcript", "description", "tags", "provenance",
    "generatorVersion", "modelChecksum", "audioChecksum", "audio", "shareable"], "reference voice");
  if (value.engine !== "qwen" || value.shareable !== true) throw new Error("This bundle includes a voice that may not be shared.");
  if (typeof value.id !== "string" || !REFERENCE_ID.test(value.id)) throw new Error("Invalid reference voice ID.");
  if (!Array.isArray(value.tags) || value.tags.length > 20 || value.tags.some((tag) => typeof tag !== "string" || tag.length > 100)) {
    throw new Error("Invalid reference voice tags.");
  }
  if (typeof value.audioChecksum !== "string" || !SHA256.test(value.audioChecksum)) {
    throw new Error("Invalid reference voice checksum in this bundle.");
  }
  return {
    id: value.id, engine: "qwen",
    label: stringOf(value.label, 100, "reference voice label"),
    transcript: stringOf(value.transcript, 1000, "reference transcript"),
    description: typeof value.description === "string" && value.description.length <= 1000 ? redactLocalPaths(value.description) : "",
    tags: [...value.tags] as string[],
    provenance: redactLocalPaths(stringOf(value.provenance, 1000, "reference voice provenance")),
    generatorVersion: stringOf(value.generatorVersion, 200, "reference generator version"),
    modelChecksum: stringOf(value.modelChecksum, 200, "reference model checksum"),
    audioChecksum: value.audioChecksum,
    audio: audioOf(value.audio, MAX_REFERENCE_BYTES, "Reference voice"),
    shareable: true,
  };
}

function parseRendered(value: unknown): BundleAudio {
  if (!object(value)) throw new Error("Invalid rendered audio in this bundle.");
  keysOf(value, ["name", "mime", "audio"], "rendered audio");
  if (value.mime !== "audio/wav") throw new Error("Rendered audio must be WAV.");
  return { name: audioName(value.name), mime: "audio/wav", audio: audioOf(value.audio, MAX_RENDERED_BYTES, "Rendered") };
}

function checkTotals(references: readonly BundleReference[], rendered: readonly BundleAudio[]): void {
  assertAssetBudget([...references.map((entry) => decodedBytes(entry.audio)), ...rendered.map((entry) => decodedBytes(entry.audio))]);
}

/** The same budget import applies, kept separate so a deliberately large entry and a large total are testable. */
export function assertAssetBudget(sizes: readonly number[]): void {
  if (sizes.length > MAX_BUNDLE_ENTRIES) throw new Error("This bundle has too many audio entries.");
  if (sizes.some((size) => !Number.isSafeInteger(size) || size < 0)) throw new Error("Invalid audio size in this bundle.");
  if (sizes.reduce((sum, size) => sum + size, 0) > MAX_TOTAL_ASSET_BYTES) throw new Error("This bundle's audio exceeds the size limit.");
}

export function createBundle(input: {
  sidecar: TableReadSidecar;
  references?: readonly BundleReference[];
  rendered?: readonly BundleAudio[];
}): TableReadBundle {
  const references = (input.references ?? []).map((reference) => {
    if (reference.shareable !== true) throw new Error("This voice's provenance does not allow sharing.");
    return parseReference(reference);
  });
  const rendered = (input.rendered ?? []).map((entry) => parseRendered(entry));
  checkTotals(references, rendered);
  const bundle: TableReadBundle = {
    format: BUNDLE_FORMAT, version: BUNDLE_VERSION,
    project: parseSidecar(input.sidecar),
    references, rendered,
  };
  if (JSON.stringify(bundle).length > MAX_BUNDLE_BYTES) throw new Error("This bundle is too large.");
  return bundle;
}

/** Parse and validate an imported bundle. Nothing here touches the document or the filesystem. */
export function parseBundle(data: Uint8Array | string): TableReadBundle {
  if (typeof data === "string" && data.length > MAX_BUNDLE_BYTES) throw new Error("That bundle is too large.");
  if (data instanceof Uint8Array && data.length > MAX_BUNDLE_BYTES) throw new Error("That bundle is too large.");
  const text = typeof data === "string" ? data : new TextDecoder().decode(data);
  if (text.length > MAX_BUNDLE_BYTES) throw new Error("That bundle is too large.");
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error("This is not a table-read bundle."); }
  if (!object(raw)) throw new Error("This is not a table-read bundle.");
  keysOf(raw, ["format", "version", "project", "references", "rendered"], "bundle");
  if (raw.format !== BUNDLE_FORMAT) throw new Error("This is not a table-read bundle.");
  if (raw.version !== BUNDLE_VERSION) throw new Error("This bundle was written by a newer version.");
  if (!Array.isArray(raw.references) || raw.references.length > MAX_BUNDLE_ENTRIES) throw new Error("Invalid reference list in this bundle.");
  if (!Array.isArray(raw.rendered) || raw.rendered.length > MAX_BUNDLE_ENTRIES) throw new Error("Invalid rendered audio in this bundle.");
  const references = raw.references.map(parseReference);
  const rendered = raw.rendered.map(parseRendered);
  checkTotals(references, rendered);
  return { format: BUNDLE_FORMAT, version: BUNDLE_VERSION, project: parseSidecar(raw.project), references, rendered };
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let at = 0; at < bytes.length; at += chunk) binary += String.fromCharCode(...bytes.subarray(at, at + chunk));
  return btoa(binary);
}

