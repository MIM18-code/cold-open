// Live co-writing (share, join, presence) and folder sync through iCloud Drive or Dropbox.
import { useState, useSyncExternalStore } from "react";

import { app, type Feature, type ModalProps } from "../../core/app.ts";
import { useSessionState, useSetting } from "../../core/hooks.ts";
import { isDesktop } from "../../core/platform.ts";
import { CollabController, NAME_SETTING, RELAY_SETTING, type CollabState } from "./controller.ts";
import "./collab.css";

export const collab = new CollabController(app);

function useCollab(): CollabState {
  return useSyncExternalStore((onChange) => collab.subscribe(onChange), () => collab.state);
}

const STATUS_LABEL: Record<CollabState["status"], string> = {
  idle: "Not shared",
  connecting: "Connecting",
  connected: "Connected",
  reconnecting: "Reconnecting",
  denied: "Refused",
  ended: "Ended",
  stopped: "Stopped",
};

async function copyText(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // The async clipboard needs window focus; fall back to the old copy command.
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  app.toast(`${what} copied`, "success");
}

function run(task: () => Promise<unknown>): void {
  task().catch((error) => app.toast(error instanceof Error ? error.message : String(error), "error"));
}

function InviteField({ label, value, className, note }: { label: string; value: string; className: string; note: string }) {
  return (
    <div className="collab-invite">
      <div className="collab-invite-label">{label}</div>
      <div className="collab-invite-row">
        <input className={`input ${className}`} readOnly value={value} aria-label={label} onFocus={(event) => event.target.select()} />
        <button className="button" onClick={() => void copyText(value, label)}>Copy</button>
      </div>
      <div className="collab-note">{note}</div>
    </div>
  );
}

// The panel's "Invite over" choice, shared with the Copy commands so both hand out the same invite.
let overTailscaleChoice = false, choiceFor: string | null = null;
const chosenInvites = (state: CollabState) => overTailscaleChoice && state.tailscale ? state.tailscale : { invite: state.invite, readOnlyInvite: state.readOnlyInvite };

function HostInvites({ state }: { state: CollabState }) {
  // A new share starts on this network (Tailscale when there's no network); reopening the panel keeps the choice.
  const [overTailscale, setOverTailscale] = useState(() => {
    if (choiceFor !== state.invite) { choiceFor = state.invite; overTailscaleChoice = !state.lan; }
    return overTailscaleChoice;
  });
  if (!state.invite || !state.readOnlyInvite) return null;
  const invites = chosenInvites(state) as { invite: string; readOnlyInvite: string };
  const selfHosted = /^wss?:\/\//.test(state.address ?? "");
  return (
    <section className="collab-section">
      {state.tailscale ? <>
        <label className="field">
          <span>Invite over</span>
          <select value={overTailscale ? "tailscale" : "lan"} onChange={(event) => setOverTailscale(overTailscaleChoice = event.target.value === "tailscale")}>
            <option value="lan" disabled={!state.lan}>This network ({state.lan ? state.address?.split(":")[0] : "unavailable"})</option>
            <option value="tailscale">Tailscale ({state.tailscale.address.split(":")[0]})</option>
          </select>
        </label>
        {overTailscale ? <p className="collab-note">Works for anyone on your Tailscale network, or anyone you share this Mac with in Tailscale. Tailscale encrypts the connection.</p> : null}
      </> : null}
      <InviteField label="Invite" value={invites.invite} className="collab-invite-write" note="Anyone with this invite can edit. Send it privately." />
      <InviteField label="Read-only invite" value={invites.readOnlyInvite} className="collab-invite-read" note="For Backlot or a reader: sees changes, cannot edit." />
      {!state.lan && !state.tailscale ? <p className="collab-error">No network found. These invites work only on this Mac.</p> : null}
      {!state.tailscale && !selfHosted ? <p className="collab-note">To write with someone on another network, use Tailscale on both Macs, or set a self-hosted relay in Settings &gt; Co-writing.</p> : null}
    </section>
  );
}

function FolderSection() {
  const state = useCollab();
  const { path } = useSessionState();
  const eligible = collab.folder.eligible(app.session);
  if (!isDesktop) return null;
  return (
    <section className="collab-section">
      <h3>Folder sync</h3>
      {state.folder.active ? (
        <p className="collab-note">The local sync service is active. Changes go to <span className="collab-path">{state.folder.folder?.split("/").pop()}</span> next to the script, so iCloud Drive or Dropbox can carry them to your other Macs.</p>
      ) : (
        <p className="collab-note">{eligible ? "Keep a sync folder next to the script so iCloud Drive or Dropbox can carry changes between Macs." : path ? "Save as a .screenplay file to sync through a folder." : "Save the script first to sync through a folder."}</p>
      )}
      <p className="collab-note">This status does not confirm upload to iCloud/Dropbox or receipt on another Mac. Keep a saved local copy; check the receiving draft before relying on it.</p>
      {state.folder.error ? <><p className="collab-error" role="alert">{state.folder.error}</p><button className="button" onClick={() => run(() => collab.folder.retry(app.session))}>Retry folder sync</button></> : null}
      <button className="button collab-folder-toggle" disabled={!eligible && !state.folder.active} onClick={() => run(() => collab.folder.toggle(app.session))}>
        {state.folder.active ? "Stop Folder Sync" : "Sync Through Folder"}
      </button>
    </section>
  );
}

function CollabPanel() {
  const state = useCollab();
  return (
    <div className="collab-panel">
      {state.mode === "idle" ? (
        <section className="collab-section">
          <p className="collab-note">Write together in real time. Sharing opens a session on your network; others join with the invite.</p>
          <div className="collab-actions">
            <button className="button primary" onClick={() => run(() => collab.share())}>Share for Co-writing</button>
            <button className="button" onClick={() => app.openModal("collab.join")}>Join…</button>
          </div>
        </section>
      ) : (
        <>
          <section className="collab-section">
            <div className="collab-status-line">
              <span className={`collab-dot collab-dot-${state.status}`} aria-hidden="true" />
              <span className="collab-status-text">{STATUS_LABEL[state.status]}</span>
              <span className="collab-note">{state.mode === "host" ? "Sharing" : "Joined"}{state.readOnly ? ", read-only" : ""}</span>
            </div>
            {state.readOnly ? <p className="collab-note">This invite is read-only. You can follow the script here but not change it.</p> : null}
            <ul className="collab-people" aria-label="People in this session">
              {state.participants.map((person) => (
                <li key={person.clientId} className="collab-person">
                  <span className="collab-swatch" style={{ background: person.color }} aria-hidden="true" />
                  <span className="collab-person-name">{person.name}</span>
                  <span className="collab-note">{[person.self ? "you" : "", person.host ? "host" : "", person.readOnly ? "read-only" : ""].filter(Boolean).join(", ")}</span>
                </li>
              ))}
            </ul>
          </section>
          {state.mode === "host" && state.invite && state.readOnlyInvite ? (
            <HostInvites key={state.invite} state={state} />
          ) : null}
          <section className="collab-section">
            <button className="button collab-stop" onClick={() => run(() => collab.stop())}>{state.mode === "host" ? "Stop Sharing" : "Leave Session"}</button>
          </section>
        </>
      )}
      <details><summary>Connection diagnostics</summary>
        <p>Live connection: {STATUS_LABEL[state.status]}. {state.lan || state.tailscale ? "The invite has a network address." : "The invite works only on this Mac."}</p>
        <p>Access: {state.readOnly ? "read-only" : "editable"}. Local draft: {app.session.dirty ? "has unsaved changes" : "no unsaved changes"}. Connected means a live transport, not that every peer saved a copy to disk.</p>
        <p>Use private invites. For the local-network invite, ws: traffic is not encrypted; use a trusted network, Tailscale, or a configured wss: relay. Incoming edits merge through the document; saving and cloud-folder delivery are separate.</p>
      </details>
      <FolderSection />
    </div>
  );
}

function CollabStatus() {
  const state = useCollab();
  if (state.mode === "idle") return state.folder.active ? <span className="collab-statusbar" title="Local sync service active; remote cloud delivery is not confirmed">{state.folder.error ? "Folder sync needs attention" : "Folder sync on"}</span> : null;
  const people = state.participants.length;
  return (
    <button className="collab-statusbar" onClick={() => app.togglePanel("collab", true)} title="Show co-writing">
      <span className={`collab-dot collab-dot-${state.status}`} aria-hidden="true" />
      {STATUS_LABEL[state.status]} · <span className="collab-count">{people}</span> {people === 1 ? "person" : "people"}
    </button>
  );
}

function JoinModal({ close }: ModalProps) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      await collab.join(text);
      close();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={(event) => (event.preventDefault(), void submit())}>
      <label className="field">
        <span>Paste the invite from the writer who is sharing</span>
        <textarea className="collab-join-input" rows={3} value={text} autoFocus spellCheck={false}
          placeholder="screenplay://join?host=…" onChange={(event) => setText(event.target.value)} />
      </label>
      {error ? <p className="collab-error">{error}</p> : null}
      <div className="modal-actions">
        <button type="button" className="button" onClick={() => (busy && void collab.stop(), close())}>Cancel</button>
        <button type="submit" className="button primary collab-join-submit" disabled={busy || !text.trim()}>{busy ? "Connecting…" : "Join"}</button>
      </div>
    </form>
  );
}

function CollabSettings() {
  const [name, setName] = useSetting(NAME_SETTING, "");
  const [relay, setRelay] = useSetting(RELAY_SETTING, "");
  return (
    <div>
      <label className="field">
        <span>Your name, as other writers see it</span>
        <input value={name} placeholder={collab.name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label className="field">
        <span>Self-hosted relay (optional)</span>
        <input value={relay} placeholder="wss://relay.example.com" spellCheck={false} onChange={(event) => setRelay(event.target.value)} />
      </label>
      <p className="collab-note">Leave the relay empty to share over your local network from this Mac. With Tailscale running, the share dialog also offers a Tailscale invite. Run your own with <code>npx screenplay-relay</code> to write together across the internet.</p>
    </div>
  );
}

const feature: Feature = {
  id: "collab",
  commands: [
    { id: "collab.share", label: "Share for Co-writing…", menu: "File", group: "collab",
      enabled: () => collab.state.mode !== "guest", run: () => collab.share() },
    { id: "collab.join", label: "Join Co-writing Session…", menu: "File", group: "collab",
      enabled: () => collab.state.mode === "idle", run: (a) => a.openModal("collab.join") },
    { id: "collab.copyInvite", label: "Copy Co-writing Invite", enabled: () => !!collab.state.invite,
      run: () => copyText(chosenInvites(collab.state).invite!, "Invite") },
    { id: "collab.copyReadOnlyInvite", label: "Copy Read-only Invite", enabled: () => !!collab.state.readOnlyInvite,
      run: () => copyText(chosenInvites(collab.state).readOnlyInvite!, "Read-only invite") },
    { id: "collab.stop", label: "Stop Sharing", menu: "File", group: "collab",
      enabled: () => collab.state.mode === "host", run: () => collab.stop() },
    { id: "collab.leave", label: "Leave Session", menu: "File", group: "collab",
      enabled: () => collab.state.mode === "guest", run: () => collab.stop() },
    { id: "collab.folderSync", label: "Sync Through Folder", menu: "File", group: "collab",
      enabled: (a) => collab.state.folder.active || collab.folder.eligible(a.session),
      checked: () => collab.state.folder.active, run: (a) => collab.folder.toggle(a.session) },
  ],
  panels: [{ id: "collab", title: "Co-writing", side: "right", order: 80, component: CollabPanel }],
  status: [{ id: "collab", order: 40, component: CollabStatus }],
  modals: [{ id: "collab.join", title: "Join Co-writing Session", width: 520, component: JoinModal }],
  settings: [{ id: "collab", title: "Co-writing", order: 60, component: CollabSettings }],
  activate: () => collab.activate(),
};

export default feature;
