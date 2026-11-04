import { isPhoneProduction, ScreenplayDoc, plainText, type PhoneProduction } from "@screenplay/engine";
import { RelayClient, type ConnectionStatus } from "@screenplay/relay/client";
import type { Pairing } from "./pairing.ts";

export const states: Record<ConnectionStatus, string> = {
  connecting: "Connecting", connected: "Live", reconnecting: "Reconnecting",
  ended: "Host stopped sharing", denied: "Refused", stopped: "Host stopped sharing",
};
export function readScript(doc: Pick<ScreenplayDoc, "paragraphs">) {
  let number = 0, scene = "";
  return doc.paragraphs().map(p => {
    const text = plainText(p.runs);
    if (p.type === "sceneHeading") { number++; scene = `Scene ${p.sceneNumber || number}`; }
    return { ...p, text, scene };
  });
}
export type Row = ReturnType<typeof readScript>[number];
export type Presence = { production?: PhoneProduction; title: string; writers: string[]; cursor: string | null; offset: number };
export function readPresence(states: Iterable<Record<string, any>>): Presence | null {
  for (const s of states) {
    if (typeof s.doc?.name !== "string" || typeof s.user?.name !== "string") continue;
    return { ...(isPhoneProduction(s.production) ? { production: s.production } : {}), title: s.doc.name, writers: [s.user.name, ...(Array.isArray(s.writers)
      ? s.writers.filter((w: unknown) => typeof w === "string").slice(0, 32) : [])],
      cursor: typeof s.cursor?.head?.paragraphId === "string" ? s.cursor.head.paragraphId : null,
      offset: Number.isSafeInteger(s.cursor?.head?.offset) ? Math.max(0, s.cursor.head.offset) : 0 };
  }
  return null;
}
export function connect(pair: Pairing, script: (rows: Row[]) => void,
  presence: (p: Presence | null) => void, status: (s: string) => void) {
  let stopped = false, attempts = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cleanup: (() => void) | undefined;
  const start = () => {
    if (stopped) return;
    const doc = new ScreenplayDoc();
    const client = new RelayClient({ ...pair.invite, doc: doc.ydoc, readOnly: true });
    client.awareness.setLocalState({ user: { name: "Cold Open Remote", app: "inklot-phone", readOnly: true }, cursor: null });
    // Each reconnect starts from an empty doc. Until the relay's sync arrives, an update would replace the cached reader with nothing.
    const update = () => { if (client.synced && readPresence(client.awareness.getStates().values())) script(readScript(doc)); };
    const offSynced = client.onSynced(update);
    const people = () => { presence(readPresence(client.awareness.getStates().values())); update(); };
    doc.ydoc.on("update", update);
    client.awareness.on("change", people);
    let disposed = false;
    cleanup = () => {
      if (disposed) return;
      disposed = true;
      doc.ydoc.off("update", update); client.awareness.off("change", people); offSynced();
      client.destroy(); doc.ydoc.destroy();
    };
    client.onStatus(s => {
      if (disposed || stopped) return;
      if (s === "connected") attempts = 0;
      status(pair.remembered && s === "reconnecting" && client.reason
        ? "Paired script is not open on the Mac" : states[s]);
      if (stopped || disposed || s !== "reconnecting") return;
      presence(null);
      cleanup?.(); cleanup = undefined;
      // Reopened FDX/Fountain scripts have new Yjs history. A fresh reader avoids merging the old copy into them.
      const wait = Math.min(30000, 500 * 2 ** Math.min(attempts++, 6));
      if (!stopped) timer = setTimeout(start, wait);
    });
  };
  start();
  return () => { stopped = true; clearTimeout(timer); cleanup?.(); };
}
