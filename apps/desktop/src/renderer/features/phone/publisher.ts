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
    const refresh = () => {
        const { name, title, cursor, writers, production } = presence();
        client.awareness.setLocalState({
            user: { name, app: "screenplay-desktop" }, doc: { name: title }, cursor, writers, production,
        });
    };
    refresh();
    return { refresh, stop: () => client.destroy(),
        onStatus: (listener: (status: ConnectionStatus, reason: string) => void) =>
            client.onStatus(status => listener(status, client.reason)),
    };
}
