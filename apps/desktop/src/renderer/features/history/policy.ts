import type { DocumentSession } from "../../core/session.ts";

/**
 * Whether the automatic timer should snapshot this session now. A script opened and left alone needs none (its file
 * already is that version), and taking one would write a history identity into it and make it look edited.
 */
export function automaticSnapshotDue(versions: WeakMap<DocumentSession, number>, session: DocumentSession): boolean {
  if (!versions.has(session) && !session.dirty) {
    versions.set(session, session.version);
    return false;
  }
  return versions.get(session) !== session.version;
}
