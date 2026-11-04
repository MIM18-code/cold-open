// Which notes the "Since last time" tray shows, and when the writer last saw a script. Pure, so the rules are
// testable without a window. The rest of the feature (tray.ts) feeds it the document and this Mac's settings.
import type { ProjectRecord } from "../rewrite/records.ts";

/** What this Mac remembers about one script: when the writer last worked on it, and the notes they put away. */
export interface SeenMemory {
  seenAt: number;
  dismissed: string[];
}

const DISMISSED_LIMIT = 100;

export function readSeen(value: unknown): SeenMemory | null {
  if (!value || typeof value !== "object") return null;
  const { seenAt, dismissed } = value as Partial<SeenMemory>;
  if (typeof seenAt !== "number" || !Number.isFinite(seenAt)) return null;
  return { seenAt, dismissed: Array.isArray(dismissed) ? dismissed.filter((id): id is string => typeof id === "string").slice(-DISMISSED_LIMIT) : [] };
}

export interface TrayInput {
  records: readonly ProjectRecord[];
  /** When the writer last worked on this script, before this session. Null for a script this Mac has not seen. */
  baseline: number | null;
  /** Notes the writer put away from this tray. */
  dismissed: ReadonlySet<string>;
  /** Notes captured in this window, which the writer already knows about. */
  own: ReadonlySet<string>;
}

/** Unresolved top-level notes created after the baseline, newest first. A script with no baseline shows nothing. */
export function trayNotes({ records, baseline, dismissed, own }: TrayInput): ProjectRecord[] {
  if (baseline === null) return [];
  return records
    .filter((r) => r.kind === "note" && !r.resolved && !r.parentId && !dismissed.has(r.id) && !own.has(r.id) && Date.parse(r.created) > baseline)
    .sort((a, b) => Date.parse(b.created) - Date.parse(a.created));
}

/**
 * The time to remember as "last seen". It is now, except that a note which arrived and was never on screen in the
 * tray (a phone note that came in while the tray was closed) keeps the time just before it, so the next visit
 * still lists it. It never moves backwards.
 */
export function nextSeenAt(now: number, previous: number | null, items: readonly ProjectRecord[], shown: ReadonlySet<string>): number {
  const unseen = items.filter((r) => !shown.has(r.id)).map((r) => Date.parse(r.created)).filter(Number.isFinite);
  const held = unseen.length ? Math.min(now, Math.min(...unseen) - 1) : now;
  return previous === null ? held : Math.max(previous, held);
}

/** Keep the dismissals for notes that still exist, newest last. */
export function pruneDismissed(dismissed: Iterable<string>, existing: ReadonlySet<string>): string[] {
  return [...dismissed].filter((id) => existing.has(id)).slice(-DISMISSED_LIMIT);
}

export function relativeTime(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export const isPhoneNote = (record: ProjectRecord): boolean => record.author === "Phone";
