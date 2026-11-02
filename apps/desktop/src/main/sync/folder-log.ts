// The update log format for folder sync. Each device appends to its own file, so iCloud Drive or Dropbox never
// sees two devices write the same file. A log is a header (magic plus a random generation) and records:
// [u32 length][u32 CRC-32][Yjs update], big-endian. A reader keeps a byte offset per log and reads only complete,
// intact records, so a file that arrives half-synced is read up to the last whole record and finished later.
// Compaction rewrites a log as one merged record under a new generation; readers that see a new generation read
// it from the start again, which is harmless because applying a Yjs update twice changes nothing.

export const LOG_EXTENSION = ".ylog";
const MAGIC = new TextEncoder().encode("SPYLOG01");
const GENERATION_BYTES = 16;
export const HEADER_BYTES = MAGIC.length + GENERATION_BYTES;
const RECORD_HEADER_BYTES = 8;
/** Larger lengths can only come from damage; a whole feature script is a few megabytes. */
const MAX_RECORD_BYTES = 256 * 1024 * 1024;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function encodeHeader(generation: Uint8Array = crypto.getRandomValues(new Uint8Array(GENERATION_BYTES))): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES);
  out.set(MAGIC, 0);
  out.set(generation.subarray(0, GENERATION_BYTES), MAGIC.length);
  return out;
}

export function encodeRecords(updates: Uint8Array[]): Uint8Array {
  const total = updates.reduce((sum, update) => sum + RECORD_HEADER_BYTES + update.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let at = 0;
  for (const update of updates) {
    view.setUint32(at, update.length, false);
    view.setUint32(at + 4, crc32(update), false);
    out.set(update, at + RECORD_HEADER_BYTES);
    at += RECORD_HEADER_BYTES + update.length;
  }
  return out;
}

export interface ParsedLog {
  /** Hex generation from the header, or null while the header has not fully arrived. */
  generation: string | null;
  records: Uint8Array[];
  /** Offset just past the last complete, intact record: where the next read starts. */
  end: number;
  /** The rest of the file is not (yet) a valid record: still arriving, or damaged. */
  incomplete: boolean;
  /** The header is not a log header at all. */
  invalid: boolean;
}

export function generationOf(bytes: Uint8Array): string | null {
  if (bytes.length < HEADER_BYTES || !MAGIC.every((byte, i) => bytes[i] === byte)) return null;
  return [...bytes.subarray(MAGIC.length, HEADER_BYTES)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Read the records from `from` (0 or a previous `end`) to the last complete one. */
export function parseLog(bytes: Uint8Array, from = 0): ParsedLog {
  const records: Uint8Array[] = [];
  if (bytes.length < HEADER_BYTES) {
    const prefixOk = MAGIC.subarray(0, bytes.length).every((byte, i) => bytes[i] === byte);
    return { generation: null, records, end: 0, incomplete: bytes.length > 0, invalid: !prefixOk };
  }
  const generation = generationOf(bytes);
  if (!generation) return { generation: null, records, end: 0, incomplete: false, invalid: true };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = Math.max(from, HEADER_BYTES);
  let incomplete = false;
  while (at < bytes.length) {
    if (at + RECORD_HEADER_BYTES > bytes.length) {
      incomplete = true;
      break;
    }
    const length = view.getUint32(at, false);
    const checksum = view.getUint32(at + 4, false);
    if (length > MAX_RECORD_BYTES || at + RECORD_HEADER_BYTES + length > bytes.length) {
      incomplete = true;
      break;
    }
    const payload = bytes.subarray(at + RECORD_HEADER_BYTES, at + RECORD_HEADER_BYTES + length);
    // A complete-looking record with the wrong checksum is a file still being filled in; wait for it.
    if (crc32(payload) !== checksum) {
      incomplete = true;
      break;
    }
    records.push(payload.slice());
    at += RECORD_HEADER_BYTES + length;
  }
  return { generation, records, end: at, incomplete, invalid: false };
}
