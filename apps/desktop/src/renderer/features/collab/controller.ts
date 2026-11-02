// Live co-writing for one window. Sharing starts the embedded relay in the main process (or uses the self-hosted
// relay from Settings) and connects this window to it as an ordinary client; joining opens the host's document in
// a fresh session, so the host's script wins. Presence carries each writer's name, color and caret.
import { ScreenplayDoc } from "@screenplay/engine";
import { RelayClient, type ConnectionStatus } from "@screenplay/relay/client";
import { deriveReadKey, deriveRoom, formatInvite, parseInvite, randomId, type Invite } from "@screenplay/relay/protocol";
import { Awareness } from "y-protocols/awareness";

import { CHANNELS } from "../../../shared/api.ts";
import { SYNC, type HostInfo } from "../../../shared/channels/sync.ts";
import type { App } from "../../core/app.ts";
import type { EditorBridge } from "../../core/editor-bridge.ts";
import { desktop, isDesktop, messageBox } from "../../core/platform.ts";
import { DocumentSession } from "../../core/session.ts";
import { FolderSyncClient, type FolderState } from "./folder.ts";
import { colorFor, cursorOf, hostDocName, participantsFrom, remoteCursorsFrom, type Participant, type PresenceState } from "./presence.ts";

export type Mode = "idle" | "host" | "guest";

export interface CollabState {
  mode: Mode;
  status: ConnectionStatus | "idle";
  participants: Participant[];
  invite: string | null;
  readOnlyInvite: string | null;
  /** Where the main invites point: host:port, or the self-hosted relay URL. */
  address: string | null;
  /** Whether a local-network address or self-hosted relay is available. */
  lan: boolean;
  tailscale: HostInfo["tailscale"];
  readOnly: boolean;
  folder: FolderState;
}

const IDLE: Omit<CollabState, "folder"> = {
  mode: "idle", status: "idle", participants: [], invite: null, readOnlyInvite: null, address: null, lan: true, tailscale: null, readOnly: false,
};

/** How long Join waits to reach the session before it gives up. */
const JOIN_TIMEOUT_MS = 15_000;

export const NAME_SETTING = "collab.name";
export const RELAY_SETTING = "collab.relayUrl";

interface Live {
  session: DocumentSession;
  client: RelayClient;
  awareness: Awareness;
  /** The relay runs in this app's main process. */
  embedded: boolean;
  /** A guest waiting for the host's script: failures go back to the Join dialog instead of a toast. */
  joining: boolean;
  cleanup: (() => void)[];
}

/**
 * Resolves once the host's script has arrived. The relay can report the session synced before the host's own
 * state has reached it (the host only just connected), leaving the guest with an empty document; showing that
 * would make the editor add an empty heading of its own, which then lands in everyone's script.
 */
function hostScript(session: DocumentSession, cleanup: (() => void)[]): Promise<void> {
  if (session.doc.paragraphs().length) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const off = session.onChange(() => {
      if (!session.doc.paragraphs().length) return;
      off();
      resolve();
    });
    // Leaving (a timeout, Cancel, another script opened) drops the listener with the abandoned session.
    cleanup.push(() => {
      off();
      reject(new Error("stopped"));
    });
  });
}

export class CollabController {
  state: CollabState;
  readonly folder: FolderSyncClient;
  private readonly app: App;
  private readonly listeners = new Set<() => void>();
  private live: Live | null = null;
  private defaultName = "";
  private editor: EditorBridge | null = null;
  private offSelection: () => void = () => undefined;
  private namedFromHost = false;

  constructor(app: App) {
    this.app = app;
    this.folder = new FolderSyncClient(app, () => this.set({ folder: this.folder.state }));
    this.state = { ...IDLE, folder: this.folder.state };
  }

  activate(): () => void {
    const offSession = this.app.onSession((session) => {
      // A Join still waiting decides for itself: the script opened here stays, and the shared one gets a new window.
      if (this.live && !this.live.joining && session !== this.live.session) {
        void this.stop("Co-writing stopped because this window opened a different script.");
      }
      this.folder.watch(session);
    });
    const offApp = this.app.subscribe(() => {
      this.bindEditor();
      this.publishUser();
    });
    this.folder.watch(this.app.session);
    if (isDesktop) {
      void desktop.invoke<string>(SYNC.userName).then((name) => {
        this.defaultName = name;
        this.publishUser();
      }).catch(() => undefined);
      // A window opened to join a session from another window picks up the invite here.
      void desktop.invoke<string | null>(SYNC.takeJoin).then((invite) => (invite ? this.join(invite) : undefined)).catch((error) => this.app.toast(String(error.message ?? error), "error"));
    }
    return () => {
      offSession();
      offApp();
      void this.stop();
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Start hosting this window's script, or show the panel if it is already shared. */
  async share(): Promise<void> {
    if (this.state.mode === "host") return this.app.togglePanel("collab", true);
    if (this.state.mode === "guest") throw new Error("Leave the current session before sharing.");
    // A section title or synopsis still being typed belongs in what the guests receive.
    this.app.flushPending();
    const relayUrl = this.app.setting<string>(RELAY_SETTING, "").trim();
    if (relayUrl) {
      if (!/^wss?:\/\/[^\s/]+/.test(relayUrl)) throw new Error("The relay address in Settings must start with ws:// or wss://.");
      // The room name comes from the key, so only a writer can open the room on the relay (docs/sync-protocol.md).
      const key = randomId();
      const invite: Invite = { relay: relayUrl.replace(/\/+$/, ""), room: await deriveRoom(key), key, readOnly: false };
      const readKey = await deriveReadKey(invite.key);
      this.connect(this.app.session, invite, "host", false, {
        invite: formatInvite(invite),
        readOnlyInvite: formatInvite({ ...invite, key: readKey, readOnly: true }),
        address: invite.relay,
        lan: true,
        tailscale: null,
      });
    } else {
      if (!isDesktop) throw new Error("Sharing needs the desktop app, or a relay address in Settings.");
      const info = await desktop.invoke<HostInfo>(SYNC.hostStart);
      this.connect(this.app.session, { relay: info.relay, room: info.room, key: info.key, readOnly: false }, "host", true, {
        invite: info.invite, readOnlyInvite: info.readOnlyInvite, address: info.address, lan: info.lan, tailscale: info.tailscale,
      });
      if (!info.lan && !info.tailscale) this.app.toast("No network found. The invite works only on this Mac until you connect to Wi-Fi.", "info");
    }
    this.app.togglePanel("collab", true);
  }

  /** Join from an invite. The host's script opens in this window if it is untitled and unchanged, otherwise in a new one. */
  async join(text: string): Promise<void> {
    const invite = parseInvite(text);
    if (this.state.mode !== "idle") throw new Error("Leave the current session first.");
    if (!this.app.session.pristine) {
      if (!isDesktop) throw new Error("Start a new script first, then join.");
      const choice = await messageBox({
        type: "question",
        message: "Open the shared script in a new window?",
        detail: "This window already has a script, so the shared one opens in its own window.",
        buttons: ["Open in New Window", "Cancel"],
        defaultId: 0,
        cancelId: 1,
      });
      if (choice !== 0) return;
      await desktop.invoke(SYNC.queueJoin, text.trim());
      await desktop.invoke(CHANNELS.newWindow);
      return;
    }
    // Start from an empty document so nothing of ours mixes into the host's script. The window keeps its own
    // script until the host's has arrived, so a stale or mistyped invite never leaves it blank.
    const original = this.app.session;
    const session = new DocumentSession(new ScreenplayDoc(), { name: "Shared script" });
    this.namedFromHost = false;
    const live = this.connect(session, invite, "guest", false, { invite: null, readOnlyInvite: null, address: invite.relay, lan: true, tailscale: null });
    live.joining = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        live.client.whenSynced().then(() => hostScript(session, live.cleanup)),
        new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("timeout")), JOIN_TIMEOUT_MS))),
      ]);
    } catch {
      const { status, reason } = live.client;
      if (this.live === live) await this.stop();
      if (status === "denied") throw new Error(`The invite was refused: ${reason || "wrong key"}.`);
      if (status === "ended") throw new Error("That session is no longer open. Ask the writer for a new invite.");
      if (status === "stopped") return;
      throw new Error(`Could not reach the session at ${invite.relay.replace(/^wss?:\/\//, "")}. Check that the writer is still sharing and that you are on the same network.`);
    } finally {
      clearTimeout(timer);
    }
    if (this.live !== live) return;
    // A draft typed into a card or outline field while waiting counts as an edit to this window's script.
    this.app.flushPending();
    // The Join dialog does not block the window: the writer may have typed, or opened a file, while the host's
    // script was on its way. Never replace that work; take the shared script to a window of its own instead.
    if (this.app.session !== original || !original.pristine) {
      await this.stop();
      if (!isDesktop) throw new Error("This window's script changed while joining. Start a new script, then join again.");
      await desktop.invoke(SYNC.queueJoin, text.trim());
      await desktop.invoke(CHANNELS.newWindow);
      this.app.toast("This script changed while you were joining, so the shared script opens in a new window.");
      return;
    }
    live.joining = false;
    this.app.setSession(session);
    this.app.togglePanel("collab", true);
  }

  /** Stop sharing (host) or leave (guest). The script stays open in this window. */
  async stop(notice?: string): Promise<void> {
    const live = this.live;
    if (!live) return;
    this.live = null;
    for (const off of live.cleanup.splice(0)) off();
    live.client.destroy();
    live.awareness.destroy();
    this.bindEditor();
    this.app.editor?.setRemoteCursors([]);
    this.set({ ...IDLE });
    if (live.embedded) await desktop.invoke(SYNC.hostStop).catch(() => undefined);
    if (notice) this.app.toast(notice);
  }

  get name(): string {
    return this.app.setting<string>(NAME_SETTING, "").trim() || this.defaultName || "Writer";
  }

  private connect(session: DocumentSession, invite: Invite, mode: Exclude<Mode, "idle">, embedded: boolean,
    info: Pick<CollabState, "invite" | "readOnlyInvite" | "address" | "lan" | "tailscale">): Live {
    const awareness = new Awareness(session.doc.ydoc);
    awareness.setLocalState(this.presence(session, mode, invite.readOnly, awareness.clientID));
    const client = new RelayClient({ relay: invite.relay, room: invite.room, key: invite.key, doc: session.doc.ydoc, awareness, readOnly: invite.readOnly });
    const live: Live = { session, client, awareness, embedded, joining: false, cleanup: [] };
    this.live = live;
    // A read-only guest's edits could never reach the others, so the editor refuses them while connected.
    if (invite.readOnly) {
      session.setReadOnly(true);
      live.cleanup.push(() => session.setReadOnly(false));
    }
    live.cleanup.push(client.onStatus((status) => this.onStatus(live, status)));
    const onAwareness = () => this.onAwareness(live);
    awareness.on("change", onAwareness);
    live.cleanup.push(() => awareness.off("change", onAwareness));
    if (mode === "host") live.cleanup.push(session.onState(() => this.publishUser()));
    this.set({ ...IDLE, ...info, mode, status: client.status, readOnly: invite.readOnly, participants: participantsFrom(awareness.getStates(), awareness.clientID) });
    this.bindEditor();
    return live;
  }

  private presence(session: DocumentSession, mode: Mode, readOnly: boolean, clientId: number): PresenceState {
    return {
      user: { name: this.name, color: colorFor(clientId), app: "screenplay-desktop", ...(readOnly ? { readOnly: true } : {}) },
      cursor: cursorOf(this.app.editor?.getSelection() ?? null),
      ...(mode === "host" ? { doc: { name: session.name } } : {}),
    };
  }

  private onStatus(live: Live, status: ConnectionStatus): void {
    if (this.live !== live) return;
    this.set({ status });
    if (live.joining) return;
    if (status === "ended") void this.stop(this.state.mode === "guest" ? "The host stopped sharing. The script stays open here." : "The session ended.");
    else if (status === "denied") void this.stop(`The invite was refused: ${live.client.reason || "wrong key"}.`);
  }

  private onAwareness(live: Live): void {
    if (this.live !== live) return;
    const states = live.awareness.getStates();
    const self = live.awareness.clientID;
    this.set({ participants: participantsFrom(states, self) });
    this.app.editor?.setRemoteCursors(remoteCursorsFrom(states, self));
    if (this.state.mode === "guest" && !this.namedFromHost) {
      const name = hostDocName(states, self);
      if (name) {
        this.namedFromHost = true;
        live.session.name = name;
        live.session.markDirty();
      }
    }
  }

  /** Follow the editor's caret while connected; the editor may mount after the session starts. */
  private bindEditor(): void {
    // Only while the shared script is the one on screen: a guest still joining must not publish a caret in its old script.
    const editor = this.live && this.live.session === this.app.session ? this.app.editor : null;
    if (editor === this.editor) return;
    this.offSelection();
    this.offSelection = () => undefined;
    this.editor = editor;
    if (!editor || !this.live) return;
    const awareness = this.live.awareness;
    this.offSelection = editor.onSelectionChange((selection) => awareness.setLocalStateField("cursor", cursorOf(selection)));
    awareness.setLocalStateField("cursor", cursorOf(editor.getSelection()));
    editor.setRemoteCursors(remoteCursorsFrom(awareness.getStates(), awareness.clientID));
  }

  /** Republish name and document title when they change. */
  private publishUser(): void {
    const live = this.live;
    if (!live) return;
    const current = live.awareness.getLocalState() as PresenceState | null;
    if (!current) return;
    const docName = this.state.mode === "host" ? live.session.name : undefined;
    if (current.user.name === this.name && current.doc?.name === docName) return;
    live.awareness.setLocalState({ ...current, user: { ...current.user, name: this.name }, ...(docName !== undefined ? { doc: { name: docName } } : {}) });
  }

  private set(change: Partial<CollabState>): void {
    const before = this.state;
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
    // Presence changes with every remote caret move; rebuild the native menu only when a command's state can change.
    const after = this.state;
    if (before.mode !== after.mode || before.invite !== after.invite || before.readOnlyInvite !== after.readOnlyInvite
      || before.folder.active !== after.folder.active) this.app.refreshMenu();
  }
}
