import type { Paragraph, PhoneProduction } from "@screenplay/engine";
export interface PhoneCue {
    id: string;
    paragraphId: string;
    speaker: string;
    text: string;
    heading: string;
}
export interface PhoneSnapshot {
    production?: PhoneProduction;
    paragraphs?: Paragraph[];
    title: string;
    revision: string;
    cues: PhoneCue[];
}
/** The Tailscale setup answers the Phone panel checklist needs. Never carries addresses or paths. */
export interface PhoneTailscale {
    installed: boolean;
    running: boolean;
    magicDns: boolean;
    https: boolean;
}
export interface PhoneInbox {
    id: string;
    deviceId?: string;
    kind: "scene-after" | "scene-end" | "draft" | "note" | "dictation" | "bookmark";
    text: string;
    cueId: string;
    paragraphId: string;
    revision: string;
    created: string;
    sourceText?: string;
}
export type RemoteCommand = "pause" | "resume" | "previous" | "next" | "stop";

/** Rows saved before device identities retain their original receipt key. */
export function phoneReceiptKey(item: Pick<PhoneInbox, "id" | "deviceId">): string {
    return item.deviceId ? `${item.deviceId}:${item.id}` : item.id;
}

export function phoneContent(item: PhoneInbox): string {
    return JSON.stringify([item.kind, item.text, item.paragraphId, item.sourceText]);
}
