// Live co-writing (share, join, presence) and folder sync through iCloud Drive or Dropbox.
import { useState, useSyncExternalStore } from "react";

import { parseInvite } from "@screenplay/relay/protocol";
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
    const copied = document.execCommand("copy");
    area.remove();
    if (!copied) {
      app.toast("Select the invite text and copy it manually.", "error");
      return;
    }
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
        <button className="button" aria-label={`Copy ${label.toLowerCase()}`} onClick={() => void copyText(value, label)}>Copy</button>
      </div>
      <div className="collab-note">{note}</div>
    </div>
  );
}

function RemoteSetup({ connected }: { connected: boolean }) {
  const [checking, setChecking] = useState(false);
  async function recheck() {
    setChecking(true);
    try { await collab.recheckNetwork(); }
    finally { setChecking(false); }
  }
  return (
    <div className="collab-remote">
      <h3>{connected ? "Tailscale is connected on this Mac" : "Connect your Macs with Tailscale"}</h3>
      <ol className="collab-steps">
        <li>{connected ? "Ask your co-writer to" : "On both Macs,"} <a href="https://tailscale.com/download/mac" target="_blank" rel="noreferrer">install Tailscale</a>, sign in and connect.</li>
        <li>If your co-writer can’t see this Mac in Tailscale, find it on your <a href="https://login.tailscale.com/admin/machines" target="_blank" rel="noreferrer">Machines page</a>. Choose <strong>Share</strong> from its menu and send the invitation privately. Your co-writer accepts it in their browser to get access to this Mac.</li>
      </ol>
      {!connected && <button className="button" disabled={checking} onClick={() => run(recheck)}>{checking ? "Checking…" : "Check Tailscale again"}</button>}
    </div>
  );
}

function HostInvites({ state }: { state: CollabState }) {
  const invites = collab.selectedInvites;
  const relay = state.inviteRoute === "relay";
  return (
    <section className="collab-section">
      {relay ? <h3>Share through your team's relay</h3> :
        <fieldset className="collab-location">
          <legend>Where is your co-writer?</legend>
          <label><input type="radio" name="invite-location" checked={state.inviteRoute === "remote"} onChange={() => collab.chooseRoute("remote")} /> On a different network</label>
          <label><input type="radio" name="invite-location" disabled={!state.lan && !!state.tailscale} checked={state.inviteRoute === "lan"} onChange={() => collab.chooseRoute("lan")} /> {state.lan || state.tailscale ? "On the same Wi-Fi or local network" : "On this Mac only"}</label>
        </fieldset>}
      {state.inviteRoute === "remote" && <RemoteSetup connected={!!state.tailscale} />}
      {state.inviteRoute === "remote" && !state.tailscale && <p className="collab-note">Once this Mac connects, check again to get the script invite. If your team runs a co-writing relay, you can also stop sharing and enter its address in Settings › Co-writing.</p>}
      {state.inviteRoute && state.status !== "connected" && <p className="collab-note" role="status">{relay ? "Waiting for your team's relay. If this continues, stop sharing and check the relay address in Settings › Co-writing." : "Waiting for the session to connect."}</p>}
      {invites && <>
        <h3>Send a script invite</h3>
        <p className="collab-note">Send one invite in a private message. Your co-writer opens the link and chooses <strong>Join</strong> in Cold Open. If their messaging app shows plain text, they can paste it into <strong>File › Join Co-writing Session…</strong>.</p>
        <InviteField label="Editing invite" value={invites.invite} className="collab-invite-write" note="Anyone with this invite can change the script." />
        <InviteField label="Read-only invite" value={invites.readOnlyInvite} className="collab-invite-read" note="Readers can follow along as you write." />
        {!relay && <p className="collab-note">Keep this Mac awake with the script open while you write together.</p>}
      </>}
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
          <p className="collab-note">Share this script with another writer, or join a script they’ve shared with you.</p>
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
              <span className="collab-status-text">{state.mode === "host" && state.status === "connected" && state.participants.length === 1 ? "Waiting for a co-writer" : STATUS_LABEL[state.status]}</span>
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
            {state.inviteRoute === "relay" && <p className="collab-note">Leaving disconnects this Mac. Other writers can keep working, and existing invites can still be used.</p>}
            <button className="button collab-stop" onClick={() => run(() => collab.stop())}>{state.mode === "host" && state.inviteRoute !== "relay" ? "Stop Sharing" : "Leave Session"}</button>
          </section>
        </>
      )}
      <details><summary>Connection diagnostics</summary>
        <p>Live connection: {STATUS_LABEL[state.status]}.</p>
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

function JoinModal({ close, props }: ModalProps<{ invite?: string } | undefined>) {
  const [text, setText] = useState(props?.invite ?? "");
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
  let preview: { host: string; readOnly: boolean } | undefined;
  if (props?.invite) {
    try {
      const invite = parseInvite(text);
      preview = { host: new URL(invite.relay).host, readOnly: invite.readOnly };
    } catch { /* A damaged link can be replaced with a fresh invite. */ }
  }
  return (
    <form onSubmit={(event) => (event.preventDefault(), void submit())}>
      {props?.invite && !preview && <p className="collab-error" role="alert">This link is incomplete or damaged. Ask the writer to copy a fresh script invite.</p>}
      {preview ? <>
        <p>{preview.readOnly ? "You’ve been invited to read a script." : "You’ve been invited to write together."}</p>
        <p className="collab-note">Only join an invite you expected from a writer you trust. Choosing Join connects to <strong>{preview.host}</strong> and shares your display name.</p>
      </> :
      <label className="field">
        <span>Paste the invite from the writer who is sharing</span>
        <textarea className="collab-join-input" rows={3} value={text} autoFocus spellCheck={false}
          placeholder="screenplay://join?host=…" onChange={(event) => setText(event.target.value)} />
      </label>}
      <p className="collab-note">{!preview && <>Use the script invite that starts with <code>screenplay://</code>. </>}If the writer also sent a Tailscale invitation, accept it in your browser and connect Tailscale before joining.</p>
      {error ? <p className="collab-error" role="alert">{error}</p> : null}
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
      <p className="collab-note">Leave this blank for Wi-Fi or Tailscale. If your team runs a relay, enter its address here before sharing. Guests only need the script invite.</p>
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
    { id: "collab.copyInvite", label: "Copy Co-writing Invite", enabled: () => !!collab.selectedInvites,
      run: () => copyText(collab.selectedInvites!.invite, "Invite") },
    { id: "collab.copyReadOnlyInvite", label: "Copy Read-only Invite", enabled: () => !!collab.selectedInvites,
      run: () => copyText(collab.selectedInvites!.readOnlyInvite, "Read-only invite") },
    { id: "collab.stop", label: "Stop Sharing", menu: "File", group: "collab",
      enabled: () => collab.state.mode === "host" && collab.state.inviteRoute !== "relay", run: () => collab.stop() },
    { id: "collab.leave", label: "Leave Session", menu: "File", group: "collab",
      enabled: () => collab.state.mode === "guest" || collab.state.inviteRoute === "relay", run: () => collab.stop() },
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
