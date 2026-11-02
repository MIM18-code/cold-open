import { openDatabaseSync } from "expo-sqlite";
import type { Outcome, Take } from "./outbox";

// Database and storage key names keep the old app name so pairings and unsent takes survive the rename.
const db = openDatabaseSync("inklot.sqlite");
db.execSync(`CREATE TABLE IF NOT EXISTS takes (
  id TEXT PRIMARY KEY, room TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
  paragraphId TEXT NOT NULL, sourceText TEXT NOT NULL, scene TEXT NOT NULL,
  created INTEGER NOT NULL, outcome TEXT NOT NULL, error TEXT)`);

export const listTakes = () => db.getAllSync<Take>("SELECT * FROM takes ORDER BY created DESC");
export function saveTake(t: Take) {
  db.runSync("INSERT INTO takes VALUES (?,?,?,?,?,?,?,?,?,NULL)", t.id, t.room, t.kind, t.text,
    t.paragraphId, t.sourceText, t.scene, t.created, t.outcome);
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
