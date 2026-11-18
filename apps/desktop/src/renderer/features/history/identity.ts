// Which Draft History a window uses. Kept apart from the panel so tests can load it without React.
import { HISTORY_ID_KEY, validHistoryId, type DocumentSession } from "../../core/session.ts";

/**
 * The session's history ID, made on request when it has none. It never follows the document's synced metadata
 * after the session starts (see DocumentSession.historyId): a session with no ID makes its own rather than take
 * one that arrived from a co-writer or a sync folder, which could be another script's.
 */
export function historyId(session: DocumentSession, create = false): string | null {
  if (session.historyId) return session.historyId;
  if (!create || session.readOnly) return null;
  const id = crypto.randomUUID();
  session.historyId = id;
  // An ID already in the document is someone else's and stays: overwriting it would send every other writer's
  // older builds, which read it from there, to a new history. This window's ID is saved in its own files' headers
  // (encodeNative); the copy in the document is for those older builds.
  if (!validHistoryId(session.doc.meta.get(HISTORY_ID_KEY))) {
    // Document identity is not a creative edit: Undo must not detach a script from its saved history.
    session.doc.ydoc.transact(() => session.doc.meta.set(HISTORY_ID_KEY, id), "history-identity");
  }
  return id;
}
