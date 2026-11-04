import { openDatabaseSync } from "expo-sqlite";
import type { Outcome, Take } from "./outbox";

// Database and storage key names keep the old app name so pairings and unsent takes survive the rename.
const db = openDatabaseSync("inklot.sqlite");
db.execSync(`CREATE TABLE IF NOT EXISTS takes (
  id TEXT PRIMARY KEY, room TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
  paragraphId TEXT NOT NULL, sourceText TEXT NOT NULL, scene TEXT NOT NULL,
  created INTEGER NOT NULL, outcome TEXT NOT NULL, error TEXT)`);

export type Passage = Pick<import("./live").Row, "id" | "scene" | "text">;
export type Composition = { kind: "draft" | "dictation" | "note"; row: Passage; text: string };
db.execSync(`CREATE TABLE IF NOT EXISTS compositions (
  room TEXT PRIMARY KEY, kind TEXT NOT NULL, paragraphId TEXT NOT NULL,
  scene TEXT NOT NULL, sourceText TEXT NOT NULL, text TEXT NOT NULL)`);
export function resumeComposition(room: string): Composition | null {
  const item = db.getFirstSync<{ kind: Composition["kind"]; paragraphId: string; scene: string; sourceText: string; text: string }>(
    "SELECT * FROM compositions WHERE room=?", room);
  return item && { kind: item.kind, row: { id: item.paragraphId, scene: item.scene, text: item.sourceText }, text: item.text };
}
export function clearComposition(room: string) {
  db.runSync("DELETE FROM compositions WHERE room=?", room);
}
export function keepComposition(room: string, item: Composition) {
  if (!item.text) return clearComposition(room);
  db.runSync("INSERT OR REPLACE INTO compositions VALUES (?,?,?,?,?,?)", room, item.kind,
    item.row.id, item.row.scene, item.row.text, item.text);
}

export const listTakes = () => db.getAllSync<Take>("SELECT * FROM takes ORDER BY created DESC");
export function saveTake(t: Take) {
  db.withTransactionSync(() => {
    db.runSync("INSERT INTO takes VALUES (?,?,?,?,?,?,?,?,?,NULL)", t.id, t.room, t.kind, t.text,
      t.paragraphId, t.sourceText, t.scene, t.created, t.outcome);
    clearComposition(t.room);
  });
}
/** Notes written before pairing, or after a pairing ended, wait under no room until a Mac is paired. */
export const UNPAIRED = "";
export function claimUnpairedNotes(room: string) {
  if (!room) return 0;
  return db.runSync("UPDATE takes SET room=? WHERE room=? AND kind='note' AND outcome='pending'", room, UNPAIRED).changes;
}
// The note screen's unsent text, kept on every keystroke so closing the app never loses it.
const CAPTURE = "\u0000capture";
export type Capture = { row: Passage | null; text: string };
export function resumeCapture(): Capture {
  const item = resumeComposition(CAPTURE);
  return item ? { row: item.row.id ? item.row : null, text: item.text } : { row: null, text: "" };
}
export function keepCapture(item: Capture) {
  keepComposition(CAPTURE, { kind: "note", row: item.row ?? { id: "", scene: "", text: "" }, text: item.text });
}
/** A note left in an earlier version's note editor moves to the note screen, after any text already there. */
export function moveNoteComposition(room: string, old: Composition) {
  const current = resumeCapture();
  keepCapture(current.text.trim() ? { row: current.row, text: `${current.text.trimEnd()}\n\n${old.text}` }
    : { row: old.row.id ? old.row : null, text: old.text });
  clearComposition(room);
}
export function saveNote(t: Take) {
  db.withTransactionSync(() => {
    db.runSync("INSERT INTO takes VALUES (?,?,?,?,?,?,?,?,?,NULL)", t.id, t.room, t.kind, t.text,
      t.paragraphId, t.sourceText, t.scene, t.created, t.outcome);
    clearComposition(CAPTURE);
  });
}
export function mark(id: string, state: Outcome, error?: string) {
  db.runSync("UPDATE takes SET outcome=?, error=? WHERE id=?", state, error ?? null, id);
}

db.execSync("CREATE TABLE IF NOT EXISTS ended (room TEXT PRIMARY KEY, reason TEXT NOT NULL, expires INTEGER NOT NULL)");
export function endedPairing(room: string): string | undefined {
  db.runSync("DELETE FROM ended WHERE expires <= ?", Date.now());
  return db.getFirstSync<{ reason: string }>("SELECT reason FROM ended WHERE room=?", room)?.reason;
}
export function rememberEnd(room: string, reason: string, expires: number) {
  db.runSync("INSERT OR REPLACE INTO ended VALUES (?, ?, ?)", room, reason, expires);
}

// A cached reader lets the writer select a passage while the Mac is asleep.
db.execSync("CREATE TABLE IF NOT EXISTS reader (room TEXT PRIMARY KEY, rows TEXT NOT NULL)");
export function cachedRows(room: string): import("./live").Row[] {
  try { return JSON.parse(db.getFirstSync<{ rows: string }>("SELECT rows FROM reader WHERE room=?", room)?.rows ?? "[]"); }
  catch { return []; }
}
export function cacheRows(room: string, rows: import("./live").Row[]) {
  db.runSync("INSERT OR REPLACE INTO reader VALUES (?,?)", room, JSON.stringify(rows));
}

db.execSync("CREATE TABLE IF NOT EXISTS production (room TEXT PRIMARY KEY, data TEXT NOT NULL)");
export function cachedProduction(room: string): import("@screenplay/engine").PhoneProduction | undefined {
  try { return JSON.parse(db.getFirstSync<{ data: string }>("SELECT data FROM production WHERE room=?", room)?.data ?? "null") ?? undefined; }
  catch { return undefined; }
}
export function cacheProduction(room: string, data: import("@screenplay/engine").PhoneProduction) {
  db.runSync("INSERT OR REPLACE INTO production VALUES (?,?)", room, JSON.stringify(data));
}
