// Locked scripts settle merged scene numbers before delivery. Unlocked duplicates stay for explicit review in
// Production > Scene Number Conflicts.
import { resolveSceneNumberConflicts, sceneNumbersLocked } from "@screenplay/engine";

import type { DocumentSession } from "../../core/session.ts";

/** Settle locked scene numbers in place. Returns whether the document changed, invalidating a prepared preview. */
export function resolveSceneNumbersForDelivery(session: DocumentSession): boolean {
  if (session.readOnly || !sceneNumbersLocked(session.doc)) return false;
  const version = session.version;
  session.doc.ydoc.transact(() => resolveSceneNumberConflicts(session.doc), "delivery-scene-numbers");
  return session.version !== version;
}
