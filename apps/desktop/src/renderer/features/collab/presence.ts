// What each writer publishes through awareness, and how the panel and the editor read it. The shape is part of
// the sync protocol (docs/sync-protocol.md), so Backlot and the phone show the same names and cursors.
import type { Position, RemoteCursor, Selection } from "../../core/editor-bridge.ts";

export interface PresenceState {
  user: { name: string; color: string; readOnly?: boolean; app?: string };
  /** Caret and selection by paragraph ID and offset, or null when the editor is not focused on the script. */
  cursor: { anchor: Position; head: Position } | null;
  /** The host's document name, so guests can title their window. */
  doc?: { name: string };
}

export interface Participant {
  clientId: number;
  name: string;
  color: string;
  self: boolean;
  readOnly: boolean;
  host: boolean;
}

const COLORS = ["#b5442c", "#2f6fdf", "#2f7d4f", "#8a4fb5", "#b07a12", "#1f8a8a", "#c2477e", "#5b6b2f"];

export function colorFor(clientId: number): string {
  return COLORS[clientId % COLORS.length]!;
}

function isPosition(value: unknown): value is Position {
  const position = value as Position | undefined;
  return !!position && typeof position.paragraphId === "string" && Number.isInteger(position.offset) && position.offset >= 0;
}

function presenceOf(state: unknown): PresenceState | null {
  const presence = state as PresenceState | undefined;
  return presence && typeof presence.user?.name === "string" ? presence : null;
}

/** Everyone in the session, this writer first, then by name. States without a user (half-joined clients) are skipped. */
export function participantsFrom(states: Map<number, unknown>, self: number): Participant[] {
  const list: Participant[] = [];
  for (const [clientId, state] of states) {
    const presence = presenceOf(state);
    if (!presence) continue;
    list.push({
      clientId,
      name: presence.user.name.slice(0, 80) || "Writer",
      color: /^#[0-9a-f]{6}$/i.test(presence.user.color) ? presence.user.color : colorFor(clientId),
      self: clientId === self,
      readOnly: !!presence.user.readOnly,
      host: !!presence.doc,
    });
  }
  return list.sort((a, b) => Number(b.self) - Number(a.self) || a.name.localeCompare(b.name) || a.clientId - b.clientId);
}

/** The other writers' carets, for EditorBridge.setRemoteCursors. */
export function remoteCursorsFrom(states: Map<number, unknown>, self: number): RemoteCursor[] {
  const cursors: RemoteCursor[] = [];
  for (const participant of participantsFrom(states, self)) {
    if (participant.self) continue;
    const cursor = presenceOf(states.get(participant.clientId))?.cursor;
    if (!cursor || !isPosition(cursor.anchor) || !isPosition(cursor.head)) continue;
    cursors.push({ clientId: participant.clientId, name: participant.name, color: participant.color, anchor: cursor.anchor, head: cursor.head });
  }
  return cursors;
}

export function cursorOf(selection: Selection | null): PresenceState["cursor"] {
  return selection ? { anchor: { ...selection.anchor }, head: { ...selection.head } } : null;
}

/** The host's document name, from whichever participant publishes one. */
export function hostDocName(states: Map<number, unknown>, self: number): string | null {
  for (const [clientId, state] of states) {
    const name = presenceOf(state)?.doc?.name;
    if (clientId !== self && typeof name === "string" && name.trim()) return name.trim().slice(0, 120);
  }
  return null;
}
