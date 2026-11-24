import { plainText, tagDefinitions, productionChanges, revisionState, compileReadPlan, DEFAULT_READ_OPTIONS, NARRATOR, type Paragraph } from "@screenplay/engine";
import { QRCodeSVG } from "qrcode.react";
import type { Invite } from "@screenplay/relay/protocol";
import { collab } from "../collab/index.tsx";
import { buildTakeContext } from "../dictation/context.ts";
import { DICTATION, type TakeResult, type ProposedElement } from "../../../shared/channels/dictation.ts";
import { publishToPhone } from "./publisher.ts";
import { useEffect, useRef, useState } from "react";
import { app, type Feature } from "../../core/app.ts";
import { desktop, messageBox } from "../../core/platform.ts";
import { useSession, useSessionState, useDocVersion } from "../../core/hooks.ts";
import { createRecord } from "../rewrite/records.ts";
import { historyId } from "../history/index.tsx";
import { draftElements } from "./draft.ts";
import { acceptPhoneRecord, filePhoneNotes, phoneAttachment, phoneSceneAttachment } from "./receipts.ts";
import { checklistOpen, setupChecklist } from "./checklist.ts";
import "./phone.css";
import { phoneDocumentKey, phoneIdentity, watchPhoneDocumentKey } from "./identity.ts";
import { getReader } from "../table-read/index.tsx";
import { CHANNELS } from "../../../shared/api.ts";
import {
    phoneReceiptKey, type PhoneInbox, type PhoneSnapshot, type PhoneTailscale, type RemoteCommand,
} from "../../../shared/channels/phone.ts";
interface Status {
    addresses: {
        address: string;
        name: string;
        tailscale?: boolean;
        hostname?: string;
    }[];
    remembered: { id: string; name: string; scriptId: string; created: number; lastSeen: number; pairAgain?: boolean; tailscale?: boolean }[];
    port: number;
    folderChosen: boolean;
    folderError: string;
    connectionError: string;
    tailscale: PhoneTailscale;
    active: boolean;
    liveRemembered: boolean;
    keepAwake: boolean;
    awake: boolean;
    url: string;
    pairing?: string;
    revision: string;
    inbox: PhoneInbox[];
    /** The Safari page's link, "" when the pairing has none, and whether that link is encrypted. */
    urlEncrypted: boolean;
    expiresAt: number | null;
}
const pathKey = (path: string) => desktop.invoke<string>("phone:path-key", path);
const moveInbox = (from: string, to: string) => desktop.invoke("phone:move-inbox", from, to);
const claimKey = (key: string) => desktop.invoke<string>("phone:claim-key", key);
const adoptLegacy = (legacyKey: string, path: string) => desktop.invoke("phone:adopt-legacy-inbox", legacyKey, path);

let productionSession: typeof app.session | undefined;
let productionSet: string | null = null;
let productionVersion = -1;
let productionResult: ReturnType<typeof productionChanges>;
let productionBaseline: Paragraph[] | undefined;
let productionTags: ReturnType<typeof tagDefinitions> | undefined;
function production() {
    const session = app.session, set = revisionState(session.doc).currentSetId;
    if (productionSession !== session || productionSet !== set) {
        productionSession = session; productionSet = set; productionVersion = -1;
        productionBaseline = structuredClone([...session.doc.paragraphs()]);
        productionTags = tagDefinitions(session.script());
    }
    if (productionVersion !== session.version) {
        productionResult = productionChanges(session.doc, productionBaseline, productionTags);
        productionVersion = session.version;
    }
    return productionResult;
}
/**
 * Pass flush = false for publishes the writer did not ask for: flushing commits fields still being typed in, and
 * some (a Story Map target) reject a partial value and clear it.
 */
function snapshot(flush = true): PhoneSnapshot {
    if (flush) app.flushPending();
    const session = app.session;
    const cues = compileReadPlan(session.script(), DEFAULT_READ_OPTIONS);
    return { production: production(), paragraphs: [...session.doc.paragraphs()], title: session.name, revision: `${session.id}:${session.version}`, cues: cues.map((c) => ({ id: c.id, paragraphId: c.paragraphIds[0] ?? "", speaker: c.speaker === NARRATOR ? "Narrator" : c.speaker, text: c.text, heading: c.sceneHeading ?? "" })) };
}
const publishers = new Map<string, () => void>();
function disconnectPublisher() {
    for (const stop of [...publishers.values()]) stop();
}
// The one-off link's room, so Stop sharing leaves remembered iPhones' publishers running.
let oneOffRoom = "";
/** Whether this window has a one-off link, from the last phone:resume. Stop One-Off Phone Link is offered only then. */
let oneOffLink = false;
function stopSharing() {
    publishers.get(oneOffRoom)?.();
    return desktop.invoke("phone:stop");
}

function attachPublisher(invite: Invite) {
    if (publishers.has(invite.room)) return;
    const session = app.session;
    const publisher = publishToPhone(invite, session.doc, () => ({
        production: production(),
        name: collab.name,
        title: session.name,
        cursor: app.editor?.getSelection() ?? null,
        writers: collab.state.participants.filter(p => !p.self && !p.readOnly).map(p => p.name),
    }));
    const offPeople = collab.subscribe(publisher.refresh);
    const offDoc = session.onChange(() => publisher.refresh());
    let editor = app.editor;
    let offCursor = editor?.onSelectionChange(publisher.refresh);
    const offApp = app.subscribe(() => {
        if (editor !== app.editor) {
            offCursor?.();
            editor = app.editor;
            offCursor = editor?.onSelectionChange(publisher.refresh);
        }
        publisher.refresh();
    });
    const stop = () => {
        publishers.delete(invite.room);
        offApp(); offDoc(); offPeople(); offCursor?.(); publisher.stop();
    };
    publishers.set(invite.room, stop);
    publisher.onStatus((status, reason) => {
        if (status === "ended" || status === "denied" || status === "reconnecting" && reason) stop();
    });
}

function PhonePanel() {
    const session = useSession(), version = useDocVersion();
    useSessionState();
    const [resolvedKey, setResolvedKey] = useState<{ identity: string; key: string } | null>(null);
    const [status, setStatus] = useState<Status | null>(null);
    const [address, setAddress] = useState("");
    const [busy, setBusy] = useState(false);
    const [formatted, setFormatted] = useState<Record<string, ProposedElement[]>>({});
    const [sceneDestinations, setSceneDestinations] = useState<Record<string, string>>({});
    const attempted = useRef(new Set<string>());
    const [error, setError] = useState("");
    const [notesUnfiled, setNotesUnfiled] = useState(false);
    const identity = phoneIdentity(session, historyId);
    const documentId = resolvedKey?.identity === identity ? resolvedKey.key : null;
    const isCurrent = () => app.session === session && identity === phoneIdentity(session, historyId);
    const [remember, setRemember] = useState(false);
    const [port, setPort] = useState("4456");
    const [safari, setSafari] = useState(false);
    const refresh = async (recheck = false) => {
        try {
            if (!documentId) return;
            let next = await desktop.invoke<Status>("phone:status", documentId, recheck);
            if (!isCurrent()) return;
            let unfiled = false;
            try {
                if (!session.readOnly && next.inbox.some(i => i.kind === "note")
                    && await filePhoneNotes(session, next.inbox, isCurrent,
                        (id, deviceId) => desktop.invoke("phone:acknowledge", documentId, id, "accepted", deviceId))) {
                    app.toast("Added notes from your iPhone to Notes.", "success");
                    next = await desktop.invoke<Status>("phone:status", documentId, false);
                    if (!isCurrent()) return;
                }
            } catch (e) {
                // Notes that can't be filed (a full script, say) stay listed below, where they can be discarded.
                setError(String(e)); unfiled = true;
            }
            setNotesUnfiled(unfiled);
            setStatus(next);
            setPort(String(next.port));
            // A stopped Tailscale drops out of the list, so keep the choice only while it is still offered.
            setAddress(a => next.addresses.some(n => n.address === a) ? a : next.addresses[0]?.address ?? "");
        } catch (e) {
            setError(String(e));
        }
    };
    useEffect(() => {
        let cancelled = false;
        setStatus(null);
        setSceneDestinations({});
        void phoneDocumentKey(session, historyId, pathKey, moveInbox, claimKey, adoptLegacy).then(key => {
            if (!cancelled) setResolvedKey({ identity, key });
        }, e => { if (!cancelled) setError(String(e)); });
        return () => { cancelled = true; };
    }, [session, identity]);
    useEffect(() => {
        if (documentId) void refresh();
        const offInbox = desktop.on("phone:inbox-changed", () => void refresh());
        const offSharing = desktop.on("phone:sharing-changed", () => void refresh());
        return () => {
            offInbox();
            offSharing();
        };
    }, [session, documentId]);
    const run = async (channel: string, ...args: unknown[]) => {
        setBusy(true);
        setError("");
        try {
            if (channel === "phone:stop") publishers.get(oneOffRoom)?.();
            const result = await desktop.invoke<{ publisher?: Invite; expiresAt?: number | null } | null>(channel, ...args);
            if (channel === "phone:start" && result?.publisher && isCurrent()) {
                if (result.expiresAt) oneOffRoom = result.publisher.room;
                attachPublisher(result.publisher);
            }
            await refresh();
        } catch (e) {
            setError(String(e));
        } finally {
            setBusy(false);
        }
    };
    const format = async (item: PhoneInbox) => {
        setBusy(true);
        setError("");
        try {
            const take = await desktop.invoke<TakeResult>(DICTATION.format, {
                takeId: Date.now(), text: item.text, extractCommands: false,
                context: buildTakeContext(session.script(), item.paragraphId),
            });
            if (take.error || !take.elements.length) throw new Error(take.error || "No formatted elements returned.");
            if (isCurrent()) setFormatted(f => ({ ...f, [phoneReceiptKey(item)]: take.elements }));
        } catch (e) { setError(String(e)); }
        finally { setBusy(false); }
    };
    useEffect(() => {
        if (busy || !documentId || !isCurrent() || session.readOnly) return;
        const item = status?.inbox.find(i => (i.kind === "dictation" || i.kind.startsWith("scene-")) && !i.cueId
            && !attempted.current.has(documentId + ":" + phoneReceiptKey(i)));
        if (!item) return;
        attempted.current.add(documentId + ":" + phoneReceiptKey(item));
        void format(item);
    }, [status, busy, session, documentId]);

    const accept = async (item: PhoneInbox, atCursor = false) => {
        try {
            if (!isCurrent() || session.readOnly || !documentId)
                throw new Error("Choose an editable script first.");
            app.flushPending();
            const cursor = atCursor ? app.editor?.getSelection()?.head ?? app.editor?.currentParagraphId() : undefined;
            if (atCursor && !cursor) throw new Error("Place the cursor in the script first.");
            const attachment = { paragraphId: item.paragraphId, sourceText: item.sourceText ?? "",
                cursor: typeof cursor === "string" ? { paragraphId: cursor, offset: 0 } : cursor ?? undefined };
            if (item.kind.startsWith("scene-")) {
                const elements = formatted[phoneReceiptKey(item)];
                if (!elements?.length) throw new Error("Format this suggestion before accepting it.");
                const record = createRecord("cut", "Phone scene suggestion", item.text);
                await acceptPhoneRecord(session, phoneReceiptKey(item), record, isCurrent, {
                    ...attachment, paragraphId: sceneDestinations[phoneReceiptKey(item)] || item.paragraphId,
                    elements, scene: item.kind === "scene-end" ? "end" : "after",
                });
                await desktop.invoke("phone:acknowledge", documentId, item.id, "accepted", item.deviceId);
                await refresh();
                return;
            }
            if (item.kind === "draft") {
                const elements = draftElements(item.text);
                const record = createRecord("cut", "Phone draft", item.text, {
                    paragraphs: elements.map(e => ({ id: "", type: e.type, runs: [{ text: e.text }] })),
                });
                await acceptPhoneRecord(session, phoneReceiptKey(item), record, isCurrent, { ...attachment, elements });
                await desktop.invoke("phone:acknowledge", documentId, item.id, "accepted", item.deviceId);
                await refresh();
                app.toast("Draft inserted after the attached passage.", "success");
                return;
            }
            const text = item.text;
            const record = item.kind === "bookmark"
                ? createRecord("bookmark", text.slice(0, 160), text)
                : item.kind === "note"
                    ? createRecord("note", "Phone note", text, { author: "Phone" })
                    : createRecord("cut", "Phone dictation to review", text, {
                        paragraphs: (formatted[phoneReceiptKey(item)] ?? [{ type: "action", text }])
                            .map(e => ({ id: "", type: e.type, runs: [{ text: e.text }] } as Paragraph)),
                    });
            await acceptPhoneRecord(session, phoneReceiptKey(item), record, isCurrent, attachment);
            await desktop.invoke("phone:acknowledge", documentId, item.id, "accepted", item.deviceId);
            await refresh();
            const destination = item.kind === "bookmark" ? "as a project bookmark"
                : item.kind === "note" ? "in project notes" : "to Cuts for review and insertion";
            app.toast(`Saved ${destination}. The script text is unchanged.`, "success");
        }
        catch (e) {
            setError(String(e));
        }
    };
    const stop = async () => {
        const response = await messageBox({ type: "warning", message: "Stop sharing with the phone?", detail: "The pairing link stops working. Remembered iPhones stay connected. To remove one, use Revoke beside it.", buttons: ["Keep", "Stop sharing"], defaultId: 0, cancelId: 0 });
        if (response !== 1) return;
        await run("phone:stop");
    };
    const revoke = async (device: { id: string; name: string }) => {
        const response = await messageBox({ type: "warning", message: `Revoke “${device.name}”?`, detail: "This iPhone is disconnected and must be paired again.", buttons: ["Keep", "Revoke"], defaultId: 0, cancelId: 0 });
        if (response !== 1) return;
        await run("phone:revoke", device.id);
    };
    const discardItem = async (item: { id: string; kind: string; deviceId?: string }) => {
        const draft = item.kind === "draft";
        const response = await messageBox({ type: "warning", message: draft ? "Ignore this draft?" : "Discard this inbox item?", detail: "It leaves this inbox and cannot be reviewed here again.", buttons: ["Keep", draft ? "Ignore" : "Discard"], defaultId: 0, cancelId: 0 });
        if (response !== 1) return;
        await run("phone:acknowledge", documentId, item.id, "ignored", item.deviceId);
    };
    const tail = status?.addresses.find(a => a.address === address)?.tailscale;
    const steps = status && setupChecklist({ tailscale: status.tailscale, remembered: status.remembered,
      showing: !status.active ? undefined : status.expiresAt ? "one-off" : "remembered",
      folderChosen: status.folderChosen });
    const setupBody = steps && <>
      <div className="phone-setup-head"><h3>Use from anywhere</h3>
        <button className="button" disabled={busy} onClick={() => void refresh(true)}>Check again</button></div>
      <p className="phone-note">Skip this if you only use the iPhone at home. Away from home, the iPhone reaches this Mac through Tailscale,
        a separate app that privately links your own devices over the internet.</p>
      <ol className="setup-steps">
        {steps.map(step => <li key={step.id}
            className={step.done ? "done" : step.optional ? "optional" : "todo"}>
          <span className="setup-mark" role="img" aria-label={step.done ? "Done" : step.optional ? "Optional" : "To do"} />
          <div>
            <div className="setup-title">{step.title}</div>
            {!step.done && <div className="setup-detail">{step.detail}</div>}
            {!step.done && step.action && <button className="button"
              onClick={() => void desktop.invoke(CHANNELS.openExternal, step.action?.url)}>{step.action.label}</button>}
          </div>
        </li>)}
      </ol>
      <p className="phone-note">While you are away, this Mac has to stay awake, with Tailscale connected and Cold Open and
        this script open. Keep this Mac awake, below, stops it going to sleep on its own. If the iPhone can’t reach the Mac, what you write
        waits on it and sends once it can.</p>
    </>;
    return <section className="roadmap-dialog phone-panel" aria-label="Phone companion">
    <div className="panel-header"><h2>Phone companion</h2></div>
    <p className="phone-lede">Read the script on your iPhone, and write, dictate or leave notes. Notes go straight into Notes. Writing and dictation arrive here for you to accept or ignore.</p>
    {status && steps && (checklistOpen(steps, status.active && !!status.pairing && status.urlEncrypted) ? <section className="phone-setup" aria-label="Use from anywhere">
      {setupBody}
    </section> : <details className="phone-setup phone-setup-fold" aria-label="Use from anywhere">
      <summary><strong>Use from anywhere</strong> <span>To use the iPhone away from home. Not needed at home.</span></summary>
      {setupBody}
    </details>)}
    {status && <>
      <label className="field"><span><input type="checkbox" aria-label="Keep this Mac awake while it shares with an iPhone"
        checked={status.keepAwake} disabled={busy} onChange={e => void run("phone:set-keep-awake", e.target.checked)} /> Keep this Mac awake while it shares with an iPhone</span></label>
      <p className="phone-note">The screen can still turn off and lock. Closing a MacBook’s lid still puts it to sleep unless it is connected to a display, so leave it open and plugged in.</p>
      {status.keepAwake && status.awake && <p className="phone-note">Keeping this Mac awake now.</p>}
    </>}
    {!status?.active ? <>
      <label className="field"><span>Connect through</span>
        <select aria-label="Phone network address" value={address} onChange={e => setAddress(e.target.value)}>
          {status?.addresses.map(a => <option key={a.address} value={a.address}>
            {a.tailscale ? a.name : `${a.name} · ${a.address}`}</option>)}
        </select>
      </label>
      <p className="phone-note">{tail ? "Encrypted automatically. Works at home and away, as long as Tailscale is connected on this Mac and the iPhone, on the same account."
        : "Encrypted automatically. No setup needed. Works only while the iPhone is on the same network as this Mac."}</p>
      <label className="field"><span><input type="checkbox" aria-label="Remember this iPhone"
        checked={remember} onChange={e => setRemember(e.target.checked)} /> Remember this iPhone</span></label>
      <p>{remember ? "Follows this saved script until revoked. Save the script before pairing."
        : "One-off pairing expires after two hours."}</p>
      <details className="phone-advanced"><summary>Advanced</summary>
        {!tail && <>
          <label className="field"><span><input type="checkbox" aria-label="Also make a Safari link, not encrypted"
            checked={safari && !remember} disabled={remember} onChange={e => setSafari(e.target.checked)} /> Also make a Safari link (not encrypted)</span></label>
          <small>{remember ? "Only for one-off pairing." : "For the table-read page in Safari. Anyone on this Wi-Fi could read what that page shows and sends. The iPhone app stays encrypted."}</small>
        </>}
        <label className="field"><span>Remembered phone port</span><input aria-label="Remembered phone port"
          type="number" min={1024} max={65535} value={port} onChange={e => setPort(e.target.value)} /></label>
        <button className="button" disabled={busy || !!status?.remembered.length} onClick={async () => {
          setError("");
          const value = Number(port);
          if (!Number.isInteger(value) || value < 1024 || value > 65535) {
            setError("Choose a port from 1024 to 65535."); return;
          }
          await run("phone:set-port", value);
        }}>Save phone port</button>
        <small>The network port remembered iPhones connect to. Change it only if another program uses {status?.port ?? 4456}, and before remembering an iPhone.</small>
      </details>
      <button className="button primary" disabled={busy || !address || !documentId}
        onClick={() => void run("phone:start", address, snapshot(), documentId, remember, safari && !tail && !remember)}>
        Start phone pairing…
      </button>
      {!status?.addresses.length && <p>Connect this Mac to Tailscale or private Wi-Fi first.</p>}
    </> : <>
      {status.pairing && <figure>
        <QRCodeSVG value={status.pairing} size={220} marginSize={4} title="Private Cold Open phone pairing code" />
        <figcaption>Scan in Cold Open on your iPhone for the live script. If the iPhone won’t accept the code, update Cold Open on it.</figcaption>
        <button className="button" onClick={() => void run("phone:copy-link", "remote")}>Copy app pairing code</button>
      </figure>}
      <p>Encrypted.{status.expiresAt ? ` Expires ${new Date(status.expiresAt).toLocaleTimeString()}.` : " Remembered until revoked."}</p>
      {status.url && <>
        <label className="field"><span>{status.urlEncrypted ? "Safari link" : "Safari link (not encrypted)"}</span>
          <input aria-label="Private phone pairing link" readOnly value={status.url} /></label>
        <button className="button" onClick={() => void run("phone:copy-link")}>Copy Safari link</button>
      </>}
      {!!status.expiresAt && <button className="button" onClick={() => void stop()}>Stop sharing / revoke link</button>}
      {!status.expiresAt && <button className="button" disabled={busy}
        onClick={() => void run("phone:new-pairing")}>Pair another iPhone</button>}
      {status.url && <>
        <p>{status.revision === `${session.id}:${version}` ? "The Safari table read has the current draft."
          : "The Safari table read has an older draft. The app follows the live screenplay."}</p>
        <button className="button" disabled={busy} onClick={() => void run("phone:publish", snapshot())}>
          Publish current draft to Safari
        </button>
      </>}
    </>}
    <h3>Remembered iPhones</h3>
    {status?.remembered.filter(d => d.scriptId === documentId).map(device => <article key={device.id}>
      <strong>{device.name}</strong>
      <p>Paired {new Date(device.created).toLocaleDateString()}. {device.pairAgain
        ? "Paired with an earlier version, so it no longer connects. Pair this iPhone again, then revoke this entry."
        : device.lastSeen ? `Last seen ${new Date(device.lastSeen).toLocaleString()}.` : "Waiting for the iPhone."}</p>
      <button className="button" disabled={busy} onClick={() => void revoke(device)}>Revoke {device.name}</button>
    </article>)}
    <p>A remembered iPhone follows the script it was paired to. If that script is closed, it keeps queueing.
      Revoking closes its connections immediately.</p>
    <button className="button" disabled={busy} onClick={() => void run("phone:choose-folder")}>
      {status?.folderChosen ? "Change iCloud Drive fallback folder…" : "Choose iCloud Drive fallback folder…"}
    </button>
    <p>Pick the same folder in the iPhone’s Status screen. Items arrive here for review.
      Accepted and Ignored return to the phone when the live link reconnects.</p>
    {status?.folderError && <p role="alert">{status.folderError}</p>}
    {status?.connectionError && <p role="alert">{status.connectionError}</p>}
    <p>Opening another document ends a one-off link. A remembered iPhone resumes when its saved script is open.</p>
    <h3>Review inbox</h3>
    <button className="button" disabled={busy || !documentId}
      onClick={() => void run("phone:clear-old-inboxes", documentId)}>Clear inboxes for other scripts…</button>
    {status?.inbox.filter(item => item.kind !== "note" || session.readOnly || notesUnfiled).map(item => <article key={phoneReceiptKey(item)}>
      <strong>{item.kind.startsWith("scene-") ? "Scene suggestion" : item.kind === "bookmark" ? "Phone bookmark" : item.kind === "note" ? "Phone note" : item.kind === "draft" ? "Phone draft" : "Rough dictation"}</strong>
      <small>{item.created} · captured draft {item.revision}</small>
      <p style={{ whiteSpace: "pre-wrap" }}>{item.text}</p>
      {(item.kind === "dictation" || item.kind.startsWith("scene-")) && <>
        <button className="button" disabled={busy} onClick={() => void format(item)}>Format transcript for review</button>
        {formatted[phoneReceiptKey(item)]?.map((e, i) => <p key={i}><small>{e.type}</small> {e.text}</p>)}
      </>}
      {item.kind === "draft" && draftElements(item.text).map((e, i) =>
        <p key={i}><small>{e.type}</small> {e.text}</p>)}
      {item.kind === "draft" && <p>Accept inserts after the attached passage.</p>}
      {item.kind.startsWith("scene-") && <p>{item.kind === "scene-end" ? "At the end of the script." : `After ${item.sourceText || "the captured Mac scene"}.`}</p>}
      {item.kind === "scene-after" && !phoneSceneAttachment(session.doc, item.paragraphId) && <label className="field">
        <span>The destination scene was removed.</span>
        <select aria-label="Scene suggestion destination" disabled={session.readOnly || busy} value={sceneDestinations[phoneReceiptKey(item)] ?? ""}
          onChange={e => setSceneDestinations(old => ({ ...old, [phoneReceiptKey(item)]: e.target.value }))}>
          <option value="">Choose a scene…</option>
          {session.doc.paragraphs().filter(p => p.type === "sceneHeading").map((p, i) =>
            <option key={p.id} value={p.id}>{p.sceneNumber ?? i + 1}. {plainText(p.runs)}</option>)}
        </select>
      </label>}
      <button className="button" disabled={session.readOnly || busy || (item.kind.startsWith("scene-") && !formatted[phoneReceiptKey(item)]) || (item.kind === "scene-after"
        ? !phoneSceneAttachment(session.doc, sceneDestinations[phoneReceiptKey(item)] || item.paragraphId)
        : item.kind !== "scene-end" && !phoneAttachment(session.doc, { paragraphId: item.paragraphId, sourceText: item.sourceText ?? "" }))} onClick={() => void accept(item)}>
        {item.kind.startsWith("scene-") ? "Accept scene" : item.kind === "bookmark" ? "Accept bookmark" : item.kind === "note" ? "Accept as project note" : item.kind === "draft" ? "Accept draft" : "Save to Cuts for review"}
      </button>
      {!item.kind.startsWith("scene-") && !phoneAttachment(session.doc, { paragraphId: item.paragraphId, sourceText: item.sourceText ?? "" }) &&
        <button className="button" disabled={session.readOnly || busy} onClick={() => void accept(item, true)}>Insert at cursor</button>}
      <button className="button"
        onClick={() => void discardItem(item)}>
        {item.kind === "draft" ? "Ignore draft" : "Discard inbox item"}
      </button>
    </article>)}
    <p>Received items stay in a bounded local inbox until accepted or discarded, even after sharing stops.
      Saved scripts keep their inbox identity after reopening at the same path. Untitled inboxes belong to this session.
      Source text that no longer matches is accepted as an unanchored note, never attached to guessed text.</p>
    {error && <p role="alert">{error}</p>}
    <button className="button" onClick={() => void refresh()}>Refresh connection</button>
  </section>;
}
function SharingStatus() {
    const [active, setActive] = useState(false);
    useEffect(() => {
        const refresh = () => {
            void desktop.invoke<Status>("phone:status").then(s => setActive(s.active || s.liveRemembered),
                () => setActive(false));
        };
        refresh();
        return desktop.on("phone:sharing-changed", refresh);
    }, []);
    return active ? <button className="reader-status-button" onClick={() => { app.setFocusMode(false); app.togglePanel("phone", true); }}>● Phone sharing active</button> : null;
}
const feature: Feature = { id: "phone", status: [{ id: "phone.sharing", order: 91, component: SharingStatus }], panels: [{ id: "phone", title: "Phone", side: "right", order: 80, component: PhonePanel }], commands: [{ id: "phone.open", label: "Phone Companion…", menu: "Tools", group: "listen", run: () => { app.setFocusMode(false); app.togglePanel("phone", true); } }, { id: "phone.stop", label: "Stop One-Off Phone Link", menu: "Tools", group: "listen", enabled: () => oneOffLink, run: () => stopSharing() }], activate(a) {
        const watch = () => {
            const session = a.session;
            let disposed = false, lastIdentity = "", resuming = false, queued = false, queuedForce = false, key = "", filing = false, again = false;
            // From the last phone:resume. An edit skipped before it answers is sent once it says something is shared.
            let shared = false, skipped = false;
            const live = () => !disposed && a.session === session;
            const fileNotes = async (): Promise<void> => {
                if (!key || !live() || session.readOnly) return;
                if (filing) { again = true; return; }
                filing = true;
                try {
                    const documentKey = key;
                    const inbox = await desktop.invoke<PhoneInbox[]>("phone:inbox", documentKey);
                    const added = await filePhoneNotes(session, inbox, live,
                        (id, deviceId) => desktop.invoke("phone:acknowledge", documentKey, id, "accepted", deviceId));
                    if (added && live()) a.toast(added === 1 ? "Added a note from your iPhone to Notes." : `Added ${added} notes from your iPhone to Notes.`, "success");
                } catch (e) { if (live()) a.toast(String(e), "error"); }
                finally { filing = false; if (again) { again = false; void fileNotes(); } }
            };
            const resume = async (force = false) => {
                if (disposed || a.session !== session) return;
                // A sharing change during a resume would otherwise be lost, leaving shared and the menu stale.
                if (resuming) { queued = true; queuedForce ||= force; return; }
                const identity = phoneIdentity(session, historyId);
                if (!force && identity === lastIdentity) return;
                lastIdentity = identity; resuming = true;
                try {
                    key = await phoneDocumentKey(session, historyId, pathKey, moveInbox, claimKey, adoptLegacy);
                    if (disposed || a.session !== session) return;
                    void fileNotes();
                    // The snapshot below carries every edit so far; only edits made while it is in flight count.
                    skipped = false;
                    const result = await desktop.invoke<{ publishers: Invite[]; shared?: boolean; oneOff?: boolean }>(
                        "phone:resume", key, snapshot(false));
                    if (!disposed && a.session === session) {
                        result.publishers.forEach(attachPublisher);
                        shared = result.shared === true;
                        oneOffLink = !!result.oneOff;
                        a.refreshMenu();
                        if (shared && skipped) {
                            skipped = false;
                            void desktop.invoke("phone:publish", snapshot(false)).catch(e => a.toast(String(e), "error"));
                        }
                    }
                } catch (e) { if (!disposed) a.toast(String(e), "error"); }
                finally {
                    resuming = false;
                    if (queued) {
                        const rerun = queuedForce;
                        queued = queuedForce = false;
                        void resume(rerun);
                    }
                }
            };
            const offKey = watchPhoneDocumentKey(session, historyId, pathKey, moveInbox,
                error => a.toast(String(error), "error"), claimKey, adoptLegacy);
            let publishTimer: ReturnType<typeof setTimeout>;
            const offProduction = session.onChange(() => {
                clearTimeout(publishTimer);
                publishTimer = setTimeout(() => {
                    // Nothing receives it with no link, no remembered iPhone and no iCloud folder.
                    if (disposed || a.session !== session) return;
                    if (!shared) { skipped = true; return; }
                    void desktop.invoke("phone:publish", snapshot(false)).catch(e => a.toast(String(e), "error"));
                }, 300);
            });
            const offState = session.onState(() => { void resume(); });
            const offSharing = desktop.on("phone:sharing-changed", () => { void resume(true); });
            const offInbox = desktop.on("phone:inbox-changed", () => { void fileNotes(); });
            void resume();
            return () => { disposed = true; clearTimeout(publishTimer); offProduction(); offKey(); offState(); offSharing(); offInbox(); };
        };
        let offIdentity = watch();
        const offSession = a.onSession(() => {
            offIdentity(); disconnectPublisher();
            oneOffLink = false; a.refreshMenu();
            const session = a.session;
            void desktop.invoke("phone:detach").then(() => {
                if (a.session === session) offIdentity = watch();
            }, e => a.toast(String(e), "error"));
        });
        const offCommand = desktop.on("phone:command", (raw) => { const command = raw as RemoteCommand, p = getReader(); if (command === "stop")
            p.stop();
        else if (command === "pause")
            p.pause();
        else if (command === "resume")
            p.resume();
        else if (command === "previous" && p.active)
            p.next(-1);
        else if (command === "next" && p.active)
            p.next(1); });
        const offTakes = desktop.on("phone:takes-imported", (raw) => {
            const { added, title } = raw as { added: number; title: string };
            a.toast(added ? `Added ${added} ${added === 1 ? "take" : "takes"} to “${title}”.`
                : `Those takes are already in “${title}”.`, "success");
        });
        return () => { offIdentity(); offSession(); offCommand(); offTakes(); };
    } };
export default feature;
