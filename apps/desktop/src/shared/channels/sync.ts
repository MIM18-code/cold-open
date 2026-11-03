// Channels for co-writing and folder sync ("sync:*"), shared by the main-process sync service and the collab feature.

export const SYNC = {
  /** renderer → main: start hosting this window's document on the embedded relay. Returns HostInfo. */
  hostStart: "sync:host-start",
  /** renderer → main: stop hosting; guests are told the session ended. The relay unbinds when no window hosts. */
  hostStop: "sync:host-stop",
  /** The macOS user's full name, the default name shown to other writers. */
  userName: "sync:user-name",
  /** Open a dedicated window after the writer has confirmed Join. */
  newJoinWindow: "sync:new-join-window",
  takeJoin: "sync:take-join",
  /** Whether folder sync is on for a document: the writer's choice, or a sync folder already next to the file. */
  folderEnabled: "sync:folder-enabled",
  folderSet: "sync:folder-set",
  /** renderer → main: start folder sync for a saved document. Args: path, current state. Returns FolderStartResult. */
  folderStart: "sync:folder-start",
  /** renderer → main: a local change to append to this device's log. Args: path, subscription, update. */
  folderAppend: "sync:folder-append",
  /** renderer → main: end one subscription (FolderStartResult.subscription). Args: path, subscription. */
  folderStop: "sync:folder-stop",
  /** main → renderer: changes from other devices. Args: path, updates. */
  folderUpdates: "sync:folder-updates",
  /** main → renderer: folder sync hit an error. Args: path, message. */
  folderError: "sync:folder-error",
} as const;

export interface JoinHandoff {
  invite: string;
  confirm: boolean;
}

export interface HostInfo {
  /** WebSocket URL this window connects to (the relay on 127.0.0.1). */
  relay: string;
  room: string;
  key: string;
  /** Read-write invite for other writers. */
  invite: string;
  /** Read-only invite, for Backlot. */
  readOnlyInvite: string;
  /** The address in the invites. */
  address: string;
  /** Whether a local-network address was found. */
  lan: boolean;
  /** Alternate invites to the same room through this Mac's Tailscale IPv4 address. */
  tailscale: { address: string; invite: string; readOnlyInvite: string } | null;
}

export interface FolderStartResult {
  folder: string;
  deviceId: string;
  /** Names this start in appends and the stop, so a stale start cannot end a newer one for the same document. */
  subscription: string;
  /** Everything the other devices have written so far. */
  updates: Uint8Array[];
}

/** Settings: per-document folder sync choices, path → on/off. */
export const FOLDER_SYNC_SETTING = "collab.folderSync";
export const DEVICE_ID_SETTING = "sync.deviceId";
