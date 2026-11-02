import type { DocumentSession } from "../../core/session.ts";

interface InboxIdentity { key?: string; pending: Promise<unknown>; }
const identities = new WeakMap<DocumentSession, InboxIdentity>();
type MoveInbox = (from: string, to: string) => Promise<unknown>;

/** The phone inbox key for a session; it never writes to the document. */
export async function phoneDocumentKey(
  session: DocumentSession,
  readHistoryId: (session: DocumentSession) => string | null,
  pathKey: (path: string) => Promise<string>,
  moveInbox: MoveInbox,
  claimKey: (key: string) => Promise<string> = async (key) => key,
  adoptLegacy: (legacyKey: string, path: string) => Promise<unknown> = async () => undefined,
): Promise<string> {
  const path = session.path, fallback = readHistoryId(session) ?? session.id;
  let state = identities.get(session);
  if (!state) {
    state = { pending: Promise.resolve() };
    identities.set(session, state);
  }
  const current = state;
  // Serialize panel refreshes and save notifications, including rapid successive Save As operations.
  const pending = current.pending.catch(() => {}).then(async () => {
    const key = path ? await pathKey(path) : await claimKey(fallback);
    // The first time a saved script is keyed by path, bring over an inbox an older version kept under its history ID.
    const legacy = readHistoryId(session);
    if (!current.key && path && legacy) await adoptLegacy(legacy, path).catch(() => undefined);
    if (current.key && current.key !== key) await moveInbox(current.key, key);
    current.key = key;
    return key;
  });
  current.pending = pending;
  return pending;
}

/** Follow saves even while the Phone panel is closed. */
export function watchPhoneDocumentKey(
  session: DocumentSession,
  readHistoryId: (session: DocumentSession) => string | null,
  pathKey: (path: string) => Promise<string>,
  moveInbox: MoveInbox,
  onError: (error: unknown) => void,
  claimKey?: (key: string) => Promise<string>,
  adoptLegacy?: (legacyKey: string, path: string) => Promise<unknown>,
): () => void {
  let previous = "";
  const refresh = () => {
    const identity = phoneIdentity(session, readHistoryId);
    if (identity === previous) return;
    previous = identity;
    void phoneDocumentKey(session, readHistoryId, pathKey, moveInbox, claimKey, adoptLegacy).catch(error => {
      if (previous === identity) previous = "";
      onError(error);
    });
  };
  const offState = session.onState(refresh), offChange = session.onChange(refresh);
  refresh();
  return () => { offState(); offChange(); };
}

export function phoneIdentity(session: DocumentSession, readHistoryId: (session: DocumentSession) => string | null): string {
  return JSON.stringify([session.id, session.path, readHistoryId(session)]);
}
