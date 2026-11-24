import { RelayClient, type ConnectionStatus } from "@screenplay/relay/client";
import type { Invite } from "@screenplay/relay/protocol";
import type { ScreenplayDoc, PhoneProduction } from "@screenplay/engine";
import type { Selection } from "../../core/editor-bridge.ts";

export interface PhonePresence {
    production?: PhoneProduction;
    name: string;
    title: string;
    cursor: Selection | null;
    writers: string[];
}

// A separate room lets Stop revoke just the phone, even during an existing co-writing session.
export function publishToPhone(invite: Invite, doc: ScreenplayDoc, presence: () => PhonePresence) {
    const client = new RelayClient({ ...invite, doc: doc.ydoc });
    // Awareness resends the whole state, production included, on every set, so send it only when something the
    // phone reads has changed. The phone follows only the caret, so the selection's far end is left out.
    let sent = "";
    const refresh = () => {
        const { name, title, cursor, writers, production } = presence();
        const state = {
            user: { name, app: "screenplay-desktop" }, doc: { name: title }, cursor: cursor && { head: cursor.head }, writers, production,
        };
        const next = JSON.stringify(state);
        if (next === sent) return;
        sent = next;
        client.awareness.setLocalState(state);
    };
    refresh();
    return { refresh, stop: () => client.destroy(),
        onStatus: (listener: (status: ConnectionStatus, reason: string) => void) =>
            client.onStatus(status => listener(status, client.reason)),
    };
}
