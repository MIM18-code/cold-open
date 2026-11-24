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

/** The shortest time between two sends of the Mac's presence to the phone, in milliseconds. */
export const PRESENCE_GAP = 200;

// A separate room lets Stop revoke just the phone, even during an existing co-writing session.
export function publishToPhone(invite: Invite, doc: ScreenplayDoc, presence: () => PhonePresence) {
    const client = new RelayClient({ ...invite, doc: doc.ydoc });
    // Awareness resends the whole state, production included, on every set, so send it only when something the
    // phone reads has changed. The phone follows only the caret, so the selection's far end is left out.
    let sent = "", last = 0, waiting: ReturnType<typeof setTimeout> | undefined;
    const send = () => {
        waiting = undefined;
        const { name, title, cursor, writers, production } = presence();
        const state = {
            user: { name, app: "screenplay-desktop" }, doc: { name: title }, cursor: cursor && { head: cursor.head }, writers, production,
        };
        const next = JSON.stringify(state);
        if (next === sent) return;
        sent = next;
        last = Date.now();
        client.awareness.setLocalState(state);
    };
    // Typing and arrow keys move the caret many times a second, and each send carries everything. The first change
    // goes at once; the ones that follow within PRESENCE_GAP go together when it has passed, with the newest state.
    const refresh = () => {
        if (waiting) return;
        // Never longer than the gap, whatever the clock does.
        const wait = Math.min(PRESENCE_GAP, last + PRESENCE_GAP - Date.now());
        if (wait <= 0) send();
        else waiting = setTimeout(send, wait);
    };
    refresh();
    return { refresh, stop: () => { clearTimeout(waiting); client.destroy(); },
        onStatus: (listener: (status: ConnectionStatus, reason: string) => void) =>
            client.onStatus(status => listener(status, client.reason)),
    };
}
