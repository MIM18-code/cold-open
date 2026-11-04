import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import * as Keychain from "expo-secure-store";
import { randomUUID } from "expo-crypto";
import { sha256 } from "./crypto";
import { decodePairing, type Pairing } from "./pairing";
import { folderProduction } from "./production.ts";
import { readScript, connect, type Presence, type Row } from "./live";
import { sendPending, deviceStatus, permanentFailure, validateTakeSize, DeliveryError, syncReceipts, type Take } from "./outbox";
import { phoneFolder, saveToFolder } from "./folder";
import { errorText } from "./errors";
import { cacheProduction, cachedProduction, cacheRows, cachedRows, endedPairing, listTakes, mark, rememberEnd, saveTake, type Passage } from "./store";
import { isTailnet, reachStatus, pairingEnded, type ReachReason } from "./reach.ts";
import { shareTakes } from "./share.ts";
import { takesFile, takesFileName, takesBatch } from "./takes-file.ts";

const key = "inklot.pairing.v1";
export function useRemote() {
  const [pair, setPair] = useState<Pairing | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [people, setPeople] = useState<Presence>({ title: "", writers: [], cursor: null, offset: 0 });
  const [status, setStatus] = useState("Connecting");
  const [takes, setTakes] = useState(listTakes);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const wake = useRef<() => void>(() => {});
  useEffect(() => {
    Keychain.getItemAsync(key).then(raw => { if (raw) setPair(decodePairing(raw, Date.now(), true)); })
      .catch(() => setError("Could not restore the pairing. Scan the Mac again.")).finally(() => setReady(true));
  }, []);
  useEffect(() => {
    setRows(pair ? cachedRows(pair.invite.room) : []); setPeople({ title: "", writers: [], cursor: null, offset: 0,
      production: pair ? cachedProduction(pair.invite.room) : undefined }); setStatus("Connecting");
    if (!pair) return;
    let stopped = false, busy = false, reported = false, wait = 1000;
    let timer: ReturnType<typeof setTimeout>, expiry: ReturnType<typeof setTimeout>;
    let disconnect: (() => void) | undefined;
    let request: AbortController | undefined;
    const end = (message: string) => {
      stopped = true; clearTimeout(timer); clearTimeout(expiry);
      request?.abort(); disconnect?.(); disconnect = undefined;
      if (message !== "Pairing expired") rememberEnd(pair.invite.room, message, pair.expiresAt);
      setStatus(message);
    };
    const unreachable = (reason: ReachReason) => setStatus(reachStatus(reason,
      { tailnet: isTailnet(pair), folder: phoneFolder.configured() }));
    const tick = async () => {
      if (stopped || busy) return;
      if (Date.now() >= pair.expiresAt) return end("Pairing expired");
      busy = true;
      clearTimeout(timer);
      request = new AbortController();
      const { signal } = request;
      const timeout = setTimeout(() => request?.abort(), 12000);
      const conflicts = new Set<string>();
      try {
        const items = listTakes().filter(t => t.room === pair.invite.room);
        const device = await deviceStatus(pair, signal);
        if (pair.remembered && device.open && !reported) {
          await deviceStatus(pair, signal, phoneFolder.deviceName()); reported = true;
        }
        if (pair.remembered && !device.open) unreachable("script-closed");
        if (items.some(t => t.outcome === "delivered" || t.outcome === "pending"
            || t.outcome === "saved" || t.outcome === "airdropped")) {
          for (const [id, state] of await syncReceipts(pair, signal, items, sha256)) {
            if (state === "conflict") {
              conflicts.add(id);
              mark(id, "pending", "Receipt conflict: the Mac decision does not match this take. It is still pending.");
            } else if (items.some(t => t.id === id && t.outcome !== state)) mark(id, state);
          }
        }
        if (!device.open) throw new DeliveryError(503, "The paired script is not open on the Mac.");
        await sendPending(pair, listTakes().filter(t => !conflicts.has(t.id)), signal, mark, sha256);
        wait = 3500;
      } catch (e) {
        if (e instanceof DeliveryError && [401, 403, 410].includes(e.status)) {
          end(pair.remembered ? "This Mac revoked the pairing" : e.status === 410 ? "Pairing expired" : "Refused");
        } else {
          if (pair.remembered) unreachable(e instanceof DeliveryError && /not open on the Mac/.test(e.message)
            ? "script-closed" : "unreachable");
          if (pair.remembered && phoneFolder.configured() && !stopped) {
            try {
              const raw = await phoneFolder.read(pair.deviceId!);
              if (raw && !stopped) {
                const snapshot = folderProduction(raw, pair.scriptId!);
                const next = readScript({ paragraphs: () => snapshot.paragraphs });
                setRows(next); cacheRows(pair.invite.room, next); cacheProduction(pair.invite.room, snapshot.production);
                setPeople({ title: snapshot.title, production: snapshot.production, writers: [], cursor: null, offset: 0 });
              }
            } catch (e) { setError(errorText(e)); }
            for (const item of listTakes().filter(t => t.room === pair.invite.room
                && t.outcome === "pending" && !conflicts.has(t.id))) {
              try { await saveToFolder(pair, item); mark(item.id, "saved"); }
              catch (error) { mark(item.id, permanentFailure(error) ? "rejected" : "pending", errorText(error)); }
            }
          }
          wait = Math.min(30000, wait * 2);
        }
      } finally {
        clearTimeout(timeout); busy = false;
        if (!stopped) { setTakes(listTakes()); timer = setTimeout(tick, wait); }
      }
    };
    // Do not reconnect on relaunch after receiving a terminal relay close code.
    const ended = endedPairing(pair.invite.room);
    if (pair.expiresAt <= Date.now()) end("Pairing expired");
    else if (ended) { stopped = true; setStatus(ended); }
    else {
      disconnect = connect(pair, next => {
        setRows(next); cacheRows(pair.invite.room, next);
      }, p => {
        if (p?.production) cacheProduction(pair.invite.room, p.production);
        setPeople(old => p ?? { ...old, writers: [], cursor: null, offset: 0 });
      }, s => {
        if (stopped) return;
        if (s === "Refused" || s === "Host stopped sharing") {
          end(pair.remembered ? "This Mac revoked the pairing"
            : Date.now() >= pair.expiresAt ? "Pairing expired" : s);
        } else if (pair.remembered && s === "Reconnecting") unreachable("unreachable");
        else if (pair.remembered && s === "Paired script is not open on the Mac") unreachable("script-closed");
        else setStatus(s);
      });
      if (!pair.remembered) expiry = setTimeout(() => end("Pairing expired"), pair.expiresAt - Date.now());
      void tick();
    }
    wake.current = tick;
    const foreground = AppState.addEventListener("change", s => { if (s === "active") void tick(); });
    return () => { stopped = true; clearTimeout(timer); clearTimeout(expiry);
      request?.abort(); disconnect?.(); foreground.remove(); wake.current = () => {}; };
  }, [pair]);

  async function scan(raw: string) {
    const next = decodePairing(raw);
    await Keychain.setItemAsync(key, raw, { keychainAccessible: Keychain.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
    setPair(next); setError("");
  }
  function submit(kind: Take["kind"], row: Passage, text: string, destination?: "after" | "end") {
    if (!pair || pair.expiresAt <= Date.now() || pairingEnded(status) || endedPairing(pair.invite.room)) {
      throw new Error("This pairing ended. Copy your text before pairing with your Mac again.");
    }
    if (destination === "after") {
      const index = rows.findIndex(r => r.id === people.cursor);
      const scene = rows.slice(0, index + 1).findLast(r => r.type === "sceneHeading");
      if (!scene) throw new Error("The Mac’s current scene is unavailable. Reconnect or choose At the end.");
      row = scene;
    }
    if (destination) kind = destination === "after" ? "scene-after" : "scene-end";
    if (!text.trim()) throw new Error("Enter some text.");
    const item: Take = { id: randomUUID(), room: pair.invite.room, kind, text: text.trim(),
      paragraphId: row.id, sourceText: row.text.slice(0, 1500), scene: row.scene, created: Date.now(), outcome: "pending" };
    validateTakeSize(item);
    saveTake(item);
    setTakes(listTakes()); wake.current();
  }
  async function sendToMac() {
    if (!pair) throw new Error("Pair with your Mac first.");
    const items = takesBatch(pair, listTakes());
    if (!(await shareTakes(takesFileName(), await takesFile(pair, items, sha256)))) return 0;
    for (const item of items) mark(item.id, "airdropped");
    setTakes(listTakes());
    return items.length;
  }
  async function forget() { await Keychain.deleteItemAsync(key); setPair(null); }
  return { pair, rows, people, status, takes, ready, error, scan, submit, forget, sendToMac };
}
