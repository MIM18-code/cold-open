// A take shared by AirDrop is one JSON file the writer dropped on Cold Open. It carries the same per-take fields as an
// iCloud folder file plus the device and script identity, and it goes through the same validator and receipt ledger
// as the folder scanner, so a take that arrives by any route is imported once.
import { openForRead } from "../safe-fs.ts";
import { receiptId, type PhoneDevices } from "./devices.ts";
import { validateFolderItem } from "./folder.ts";
import type { PhoneInboxStore } from "./inbox.ts";

export const takesFileExtension = ".coldopentakes";
/** Files an iPhone made before the app was renamed. Still imported; new files use `takesFileExtension`. */
export const legacyTakesFileExtension = ".inklottakes";
export function isTakesFileName(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(takesFileExtension) || lower.endsWith(legacyTakesFileExtension);
}
/** The phone caps one batch at 100 takes, each within the 26,000-byte iCloud file limit. */
export const takesFileLimit = 2_600_000;
const maxTakes = 100;
const scriptIdentity = /^[a-f0-9]{64}$/;

export interface TakesImportResult {
  added: number;
  title: string;
  scriptId: string;
}
/** The window-owned inbox a script identity belongs to, with the title shown in its window. */
type OpenScript = { title: string } | undefined;
export type OpenScriptLookup = (scriptId: string) => OpenScript | Promise<OpenScript>;
export interface ParsedTakesFile {
  deviceId: string;
  scriptId: string;
  takes: unknown[];
}

export function parseTakesFile(bytes: Uint8Array): ParsedTakesFile {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("That is not a Cold Open takes file.");
  }
  const file = value as Record<string, unknown> | null;
  if (!file || typeof file !== "object" || file.v !== 1
      || typeof file.deviceId !== "string" || !receiptId.test(file.deviceId)
      || typeof file.scriptId !== "string" || !scriptIdentity.test(file.scriptId)
      || !Array.isArray(file.takes) || !file.takes.length || file.takes.length > maxTakes) {
    throw new Error("That is not a valid Cold Open takes file.");
  }
  return { deviceId: file.deviceId, scriptId: file.scriptId, takes: file.takes };
}

/**
 * Import every take in a `.coldopentakes` file into its script's inbox. Refuses a file from an iPhone this Mac does
 * not remember, a file for another script, and a file for a script no window has open. Duplicate receipt IDs are
 * counted as already added rather than appended twice.
 */
export async function importTakesFile(path: string, devices: PhoneDevices, store: PhoneInboxStore,
    open: OpenScriptLookup): Promise<TakesImportResult> {
  const file = await openForRead(path);
  if (!file) throw new Error("That takes file could not be opened.");
  let parsed: ParsedTakesFile;
  try {
    if (file.info.size > takesFileLimit) throw new Error("That takes file is too large to import.");
    parsed = parseTakesFile(await file.read(takesFileLimit));
  } finally {
    await file.close();
  }
  const { deviceId, scriptId, takes } = parsed;
  const device = devices.device(deviceId);
  if (!device || device.revoked) throw new Error("That takes file is from an iPhone this Mac no longer remembers.");
  if (device.scriptId !== scriptId) throw new Error("That takes file belongs to a different script.");
  const script = await open(scriptId);
  if (!script) throw new Error("Open the script these takes belong to, then open the file again.");
  // Validate every take before adding any, so a malformed file changes nothing.
  const items = takes.map(take => {
    const item = take as Record<string, unknown> | null;
    const v = typeof item?.kind === "string" && item.kind.startsWith("scene-") ? 2 : 1;
    // Rebuild the iCloud envelope and reuse its size, identity and signature checks.
    return validateFolderItem({ ...item, v, deviceId, scriptId }, deviceId, scriptId,
      devices.verifyTake.bind(devices));
  });
  let added = 0;
  for (const item of items) {
    if (await devices.receive(deviceId, scriptId, item, store)) added++;
  }
  return { added, title: script.title, scriptId };
}
