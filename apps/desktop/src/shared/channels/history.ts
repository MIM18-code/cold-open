export const HISTORY = { list: "history:list", record: "history:record", read: "history:read", remove: "history:remove" } as const;
export interface HistoryEntry { id: string; label: string; at: string; bytes: number; hash: string; named: boolean; }
export interface HistoryRecord { documentId: string; label: string; named: boolean; data: Uint8Array; }
export const HISTORY_LIMITS = { entries: 64, named: 20, snapshotBytes: 16 * 1024 * 1024, documentBytes: 128 * 1024 * 1024 } as const;
