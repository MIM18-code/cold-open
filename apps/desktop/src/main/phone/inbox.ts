import { mkdir, readdir, realpath, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { openForRead, replaceFile } from "../safe-fs.ts";
import { phoneContent, phoneReceiptKey, type PhoneInbox } from "../../shared/channels/phone.ts";

type InboxKey = string | (() => string);

function validateKey(key: unknown): asserts key is string {
    if (typeof key !== "string" || !/^[-a-zA-Z0-9_]{12,80}$/.test(key)) {
        throw new Error("Invalid phone document identity.");
    }
}

export class PhoneInboxStore {
    private readonly root: string;
    private tail: Promise<unknown> = Promise.resolve();
    constructor(root: string) { this.root = root; }

    private async path(key: string): Promise<string> {
        validateKey(key);
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        const location = join(await realpath(dirname(resolve(this.root))), basename(resolve(this.root)));
        if (await realpath(this.root) !== location) throw new Error("The phone inbox folder cannot be redirected.");
        return join(this.root, key + ".json");
    }

    async list(key: string): Promise<PhoneInbox[]> {
        const path = await this.path(key), file = await openForRead(path);
        if (!file) return [];
        try {
            if (file.info.size > 3000000) throw new Error("The saved phone inbox exceeds its limit.");
            const rows = JSON.parse(new TextDecoder().decode(await file.read()));
            if (!Array.isArray(rows) || rows.length > 100 || rows.some(r =>
                !r || typeof r.id !== "string" || !/^[-\w]{12,80}$/.test(r.id) ||
                !["scene-after", "scene-end", "draft", "note", "dictation", "bookmark"].includes(r.kind) || typeof r.text !== "string" || r.text.length > 20000 ||
                typeof r.paragraphId !== "string" || typeof r.revision !== "string" || typeof r.created !== "string" ||
                (r.sourceText !== undefined && typeof r.sourceText !== "string") ||
                (r.deviceId !== undefined && (typeof r.deviceId !== "string" || !/^[-\w]{12,80}$/.test(r.deviceId))))) {
                throw new Error("The saved phone inbox is damaged; its contents were not overwritten.");
            }
            return rows;
        } finally {
            await file.close();
        }
    }

    private enqueue<T>(work: () => Promise<T>): Promise<T> {
        // Capacity checks and explicit cleanup must serialize across projects as well as within one inbox.
        const next = this.tail.catch(() => {}).then(work);
        this.tail = next;
        return next;
    }

    private update(key: InboxKey, change: (rows: PhoneInbox[]) => PhoneInbox[]): Promise<void> {
        return this.enqueue(async () => {
            // Pairings resolve their target inside the queue, after any preceding move has retargeted them.
            const resolvedKey = typeof key === "function" ? key() : key;
            const rows = change(await this.list(resolvedKey)), path = await this.path(resolvedKey);
            if (rows.length > 100) throw new Error("Review the 100 saved phone items before sending more.");
            if (!rows.length) {
                await unlink(path).catch((e: NodeJS.ErrnoException) => {
                    if (e.code !== "ENOENT") throw e;
                });
                return;
            }
            const existing = await openForRead(path);
            if (existing) await existing.close();
            if (!existing && (await readdir(this.root)).filter(n => n.endsWith(".json")).length >= 100) {
                throw new Error("The phone inbox already stores 100 projects. Clear old inboxes in the Phone panel first.");
            }
            await replaceFile(path, path + "." + randomUUID() + ".saving", JSON.stringify(rows));
        });
    }

    move(from: unknown, to: unknown, retarget: (from: string, to: string) => void = () => {}): Promise<void> {
        return this.enqueue(async () => {
            validateKey(from);
            validateKey(to);
            if (from === to) return;
            const source = await this.list(from), target = await this.list(to);
            const merged = [...target];
            for (const row of source) this.add(merged, row);
            if (merged.length > 100) throw new Error("Review the 100 saved phone items before moving this inbox.");
            const data = JSON.stringify(merged);
            if (Buffer.byteLength(data) > 3000000) throw new Error("The saved phone inbox exceeds its limit.");
            if (source.length) {
                const destination = await this.path(to);
                // Commit the merged copy before removing the source. Retrying after interruption deduplicates IDs.
                await replaceFile(destination, destination + "." + randomUUID() + ".saving", data);
                await unlink(await this.path(from));
            }
            retarget(from, to);
        });
    }

    clearOther(keep: readonly string[]): Promise<number> {
        return this.enqueue(async () => {
            // Validate the inbox root even when there are no files to remove.
            await this.path(keep[0] ?? "inbox-validation");
            const kept = new Set(keep.map(key => key + ".json"));
            let removed = 0;
            for (const name of await readdir(this.root)) {
                if (!/^[-a-zA-Z0-9_]{12,80}\.json$/.test(name) || kept.has(name)) continue;
                await unlink(join(this.root, name));
                removed++;
            }
            return removed;
        });
    }

    attributeLegacy(key: string, deviceFor: (item: PhoneInbox) => string | undefined): Promise<void> {
        return this.update(key, rows => {
            const migrated: PhoneInbox[] = [];
            for (const row of rows) {
                const deviceId = row.deviceId ?? deviceFor(row);
                this.add(migrated, deviceId ? { ...row, deviceId } : row);
            }
            return migrated;
        });
    }

    private add(rows: PhoneInbox[], item: PhoneInbox): void {
        const existing = rows.find(r => phoneReceiptKey(r) === phoneReceiptKey(item));
        if (existing && phoneContent(existing) !== phoneContent(item))
            throw new Error("That receipt ID was already used for different content.");
        if (!existing) rows.push(item);
    }
    append(key: InboxKey, item: PhoneInbox): Promise<void> {
        return this.update(key, rows => { this.add(rows, item); return rows; });
    }
    remove(key: string, id: string, deviceId?: string): Promise<void> {
        const receipt = phoneReceiptKey({ id, deviceId });
        return this.update(key, rows => rows.filter(r => phoneReceiptKey(r) !== receipt));
    }
    async flush(): Promise<void> { await Promise.allSettled([this.tail]); }
}
