import { isPhoneProduction, isElementType } from "@screenplay/engine";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createSecureServer } from "node:https";
import type { PhoneTls } from "./tls.ts";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import { createRelay, type Relay } from "@screenplay/relay";
import { formatInvite, type Invite } from "@screenplay/relay/protocol";
import { ReplayGuard, fromBase64url, linkKeys, linkRoot } from "@screenplay/relay/sealed";
import { nodeLinkCrypto } from "@screenplay/relay/sealed-node";
import { digest, matchesToken } from "./devices.ts";
import { serveLink, type PhoneLink, type PhoneReply } from "./link.ts";
import type { RememberedPhone } from "./devices.ts";
import type { PhoneHost } from "./host.ts";
import { phonePage } from "./web.ts";
import { phoneContent, type PhoneSnapshot, type PhoneInbox, type RemoteCommand } from "../../shared/channels/phone.ts";
export function lanAddresses(): {
    address: string;
    name: string;
}[] {
    return Object.entries(networkInterfaces()).flatMap(([name, rows]) => (rows ?? []).filter((r) => r.family === "IPv4" && !r.internal && /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(r.address)).map((r) => ({ address: r.address, name })));
}
export function validateSnapshot(value: unknown): PhoneSnapshot {
    const s = value as PhoneSnapshot | null;
    if (!s || typeof s.title !== "string" || s.title.length > 300 || typeof s.revision !== "string" || !/^[\w:-]{1,160}$/.test(s.revision) || !Array.isArray(s.cues) || s.cues.length > 5000 || JSON.stringify(s).length > 2000000)
        throw new Error("The phone reading is too large or invalid.");
    const ids = new Set<string>();
    const cues = s.cues.map((c) => {
        if (!c || typeof c.id !== "string" || !c.id || c.id.length > 200 || ids.has(c.id) || typeof c.paragraphId !== "string" || c.paragraphId.length > 160 || typeof c.speaker !== "string" || c.speaker.length > 160 || typeof c.heading !== "string" || c.heading.length > 500 || typeof c.text !== "string" || c.text.length > 1500)
            throw new Error("Invalid phone reading passage.");
        ids.add(c.id);
        return { id: c.id, paragraphId: c.paragraphId, speaker: c.speaker, heading: c.heading, text: c.text };
    });
    if (s.production && !isPhoneProduction(s.production)) throw new Error("Invalid production changes.");
    if (s.paragraphs && (!Array.isArray(s.paragraphs) || s.paragraphs.length > 50000
        || s.paragraphs.some(p => !p || typeof p.id !== "string" || !isElementType(p.type) || !Array.isArray(p.runs)
            || p.runs.some(r => typeof r.text !== "string")))) throw new Error("Invalid phone script.");
    return { title: s.title, revision: s.revision, cues, ...(s.production ? { production: s.production } : {}),
        ...(s.paragraphs ? { paragraphs: s.paragraphs } : {}) };
}
export class PhoneServer {
    private server: Server | null = null;
    private relay?: Relay;
    private room?: string;
    private outcomes = new Map<string, { outcome: "accepted" | "ignored"; contentHash: string }>();
    private deviceId: string = randomUUID();
    private token = randomBytes(32).toString("base64url");
    private host = "";
    private scriptId = "";
    private shared?: PhoneHost;
    private tokenHash?: string;
    private reportDevice?: (name?: string) => Promise<void>;
    private readDecisions?: () => Record<string, unknown>;
    private origin = "";
    /** Home Wi-Fi: every request and relay message is sealed under keys from the pairing secret, which is never sent. */
    private link?: PhoneLink;
    /** Home Wi-Fi, only when the writer asked for a Safari link: a separate bearer for the unencrypted browser page. */
    private browserToken = "";
    private expiry: ReturnType<typeof setTimeout> | undefined;
    private readonly deliveries = new Map<string, {
        signature: string; contentHash: string; promise: Promise<PhoneInbox>;
    }>();
    private inFlight = 0;
    private snapshot: PhoneSnapshot;
    private readonly onCommand: (command: RemoteCommand) => void;
    private readonly onInbox: (item: PhoneInbox) => void | Promise<void>;
    private readonly inbox: PhoneInbox[] = [];
    private readonly rates = new Map<string, {
        at: number;
        count: number;
    }>();
    private closed = false;
    constructor(snapshot: PhoneSnapshot, onCommand: (command: RemoteCommand) => void = () => { }, onInbox: (item: PhoneInbox) => void | Promise<void> = () => { }) { this.snapshot = validateSnapshot(snapshot); this.onCommand = onCommand; this.onInbox = onInbox; }
    async start(address: string, tls?: PhoneTls, onClose?: () => void, lifetimeMs = 2 * 60 * 60 * 1000, hostname = address,
        browser = false): Promise<{
        /** The Safari page's link, or "" when this pairing has none. */
        url: string;
        pairing: string;
        publisher: Invite;
        address: string;
        /** Whether the Safari link is encrypted. The link to the iPhone app always is. */
        encrypted: boolean;
        expiresAt: number;
    }> {
        if (this.server || this.closed)
            throw new Error("This phone session cannot be started again.");
        if (!tls) this.link = { keys: linkKeys(nodeLinkCrypto, linkRoot(nodeLinkCrypto, this.token)), guard: new ReplayGuard(nodeLinkCrypto),
            handle: request => this.handle(request.m, request.p, request.b) };
        if (!tls && browser) this.browserToken = randomBytes(32).toString("base64url");
        const nonce = randomBytes(18).toString("base64url"), html = phonePage(nonce, !!tls);
        const handler = (req: IncomingMessage, res: ServerResponse) => { void this.route(req, res, html, nonce).catch(() => { if (!res.headersSent)
            this.json(res, 400, { error: "Invalid phone request." });
        else
            res.destroy(); }); };
        this.server = tls ? createSecureServer(tls.options, handler) : createServer(handler);
        this.server.once("close", () => onClose?.());
        this.server.requestTimeout = 10000;
        this.server.headersTimeout = 10000;
        this.server.keepAliveTimeout = 1000;
        this.server.maxConnections = 16;
        await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(0, address, () => { this.server!.removeListener("error", reject); resolve(); }); });
        this.server.on("error", () => { void this.stop(); });
        const info = this.server.address();
        if (!info || typeof info === "string")
            throw new Error("Could not start phone pairing.");
        this.host = `${hostname}:${info.port}`;
        this.origin = `${tls ? "https" : "http"}://${this.host}`;
        const expiresAt = Date.now() + Math.max(1, Math.min(lifetimeMs, 2 * 60 * 60 * 1000));
        const link = this.link;
        this.relay = await createRelay({ readerServer: this.server,
            ...(link ? { readerSealed: (id: string) => id === link.keys.id ? link.keys : undefined } : {}) });
        const keys = this.relay.createRoom();
        this.room = keys.room;
        const publisher = {
            relay: `ws://127.0.0.1:${this.relay.port}`, room: keys.room, key: keys.key, readOnly: false,
        };
        const invite = formatInvite({
            relay: this.origin.replace(/^http/, "ws"), room: keys.room, key: keys.readKey, readOnly: true,
        });
        const url = tls ? `${this.origin}/#${this.token}` : this.browserToken ? `${this.origin}/#${this.browserToken}` : "";
        const pairing = JSON.stringify(tls ? { v: 1, url, invite, expiresAt }
            : { v: 3, host: this.host, secret: this.token, invite, expiresAt });
        this.expiry = setTimeout(() => { void this.stop(); }, expiresAt - Date.now());
        this.expiry.unref();
        return { url, publisher, pairing, address, encrypted: !!tls, expiresAt };
    }
    attach(host: PhoneHost, device: RememberedPhone, token: string | undefined,
        report: (name?: string) => Promise<void>, decisions: () => Record<string, unknown>, guard = new ReplayGuard(nodeLinkCrypto)) {
        this.shared = host;
        this.deviceId = device.id;
        this.scriptId = device.scriptId;
        this.tokenHash = device.tokenHash;
        this.reportDevice = report;
        this.readDecisions = decisions;
        this.origin = host.origin;
        this.host = new URL(host.origin).host;
        this.relay = host.relay;
        const keys = this.relay.createRoom(device.writerKey);
        this.room = keys.room;
        if (device.root) {
            this.link = { keys: linkKeys(nodeLinkCrypto, fromBase64url(device.root)), guard, handle: (request, remote) =>
                this.limited(remote) ? Promise.resolve({ status: 429, body: { error: "Too many requests." } })
                    : this.handle(request.m, request.p, request.b) };
            host.links.set(this.link.keys.id, this.link);
        } else host.routes.set(device.tokenHash, (req, res) => this.route(req, res, "", ""));
        const publisher: Invite = { relay: `ws://127.0.0.1:${host.relay.port}`,
            room: keys.room, key: keys.key, readOnly: false };
        const invite = formatInvite({ relay: host.origin.replace(/^http/, "ws"), room: keys.room,
            key: keys.readKey, readOnly: true });
        const identity = { expiresAt: null, remembered: true, deviceId: device.id, scriptId: device.scriptId, invite };
        // A home Wi-Fi pairing has no Safari page: its secret must never be sent, and a bearer is nothing else.
        const url = token && !device.root ? `${host.origin}/#${token}` : "";
        const pairing = !token ? "" : JSON.stringify(device.root ? { v: 3, host: this.host, secret: token, ...identity }
            : { v: 1, url, ...identity });
        return { publisher, url, pairing, address: device.address, encrypted: !device.root, expiresAt: null };
    }
    publish(snapshot: PhoneSnapshot): void { if (this.closed)
        throw new Error("Phone link is closed."); this.snapshot = validateSnapshot(snapshot); }
    items(): PhoneInbox[] { return structuredClone(this.inbox); }
    acknowledge(id: string, outcome: "accepted" | "ignored" = "ignored", deviceId = this.deviceId): void {
        if (deviceId !== this.deviceId) return;
        const delivery = this.deliveries.get(id);
        if (delivery) this.outcomes.set(id, { outcome, contentHash: delivery.contentHash });
        const index = this.inbox.findIndex((item) => item.id === id);
        if (index >= 0) this.inbox.splice(index, 1);
    }
    async stop(revoked = false): Promise<void> {
        this.closed = true;
        clearTimeout(this.expiry);
        if (this.room) this.relay?.closeRoom(this.room, this.shared ? revoked ? 4401 : 4425 : 4404);
        if (this.shared && this.tokenHash) this.shared.routes.delete(this.tokenHash);
        if (this.shared && this.link && this.shared.links.get(this.link.keys.id) === this.link) this.shared.links.delete(this.link.keys.id);
        if (!this.shared) await this.relay?.close();
        this.relay = undefined;
        this.deliveries.clear();
        this.outcomes.clear();
        this.token = randomBytes(32).toString("base64url");
        this.snapshot = { title: "", revision: "closed", cues: [] };
        this.inbox.length = 0;
        this.rates.clear();
        const server = this.server;
        this.server = null;
        if (server) {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    }
    private json(res: ServerResponse, status: number, value: unknown): void { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }); res.end(JSON.stringify(value)); }
    /** Who a bearer speaks for: the paired app or page over HTTPS, the opted-in Safari page on home Wi-Fi, or nobody. */
    private authenticated(req: IncomingMessage): "paired" | "browser" | null {
        const value = req.headers.authorization;
        if (typeof value !== "string" || !value.startsWith("Bearer ")) return null;
        const same = (expected: string) => { const a = Buffer.from(value.slice(7)), b = Buffer.from(expected); return a.length === b.length && timingSafeEqual(a, b); };
        // On home Wi-Fi the pairing secret is a key, never a bearer: presenting it in the clear proves nothing.
        if (this.link) return this.browserToken && same(this.browserToken) ? "browser" : null;
        if (this.tokenHash) return matchesToken(value.slice(7), this.tokenHash) ? "paired" : null;
        return same(this.token) ? "paired" : null;
    }
    private limited(remote: string): boolean {
        const now = Date.now(), previous = this.rates.get(remote), rate = previous && now - previous.at < 1000 ? previous : { at: now, count: 0 };
        rate.count++;
        if (this.rates.size >= 64 && !this.rates.has(remote))
            this.rates.clear();
        this.rates.set(remote, rate);
        return rate.count > 20;
    }
    private async body(req: IncomingMessage): Promise<any> {
        if (!req.headers["content-type"]?.startsWith("application/json"))
            throw new Error("JSON required.");
        if (Number(req.headers["content-length"] ?? 0) > 24000)
            throw new Error("Request too large.");
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const part of req) {
            const chunk = Buffer.from(part);
            size += chunk.length;
            if (size > 24000)
                throw new Error("Request too large.");
            chunks.push(chunk);
        }
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    }
    /** The listener's front door. Home Wi-Fi takes sealed requests at /link; HTTPS, and an opted-in Safari page, take a bearer. */
    private async route(req: IncomingMessage, res: ServerResponse, html: string, nonce: string): Promise<void> {
        if (this.closed)
            return this.json(res, 410, { error: "Pairing ended." });
        if (req.headers.host !== this.host)
            return this.json(res, 403, { error: "Host refused." });
        const origin = req.headers.origin;
        if (origin && origin !== this.origin)
            return this.json(res, 403, { error: "Origin refused." });
        if (this.limited(req.socket.remoteAddress ?? ""))
            return this.json(res, 429, { error: "Too many requests." });
        if (this.link && req.method === "POST" && req.url === "/link")
            return serveLink(req, res, id => id === this.link!.keys.id ? this.link : undefined);
        if (this.link && !this.browserToken)
            return this.json(res, 404, { error: "Not found." });
        if (req.method === "GET" && req.url === "/") {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`, "permissions-policy": "camera=(), microphone=(), geolocation=()" });
            res.end(html);
            return;
        }
        const who = this.authenticated(req);
        if (!who)
            return this.json(res, 401, { error: "Reopen the pairing link from Cold Open." });
        const reply = await this.handle(req.method ?? "", req.url ?? "", req.method === "POST" ? await this.body(req) : undefined, who === "browser");
        this.json(res, reply.status, reply.body);
    }
    /**
     * One authenticated request, whichever way it arrived. `browser` marks the unencrypted Safari page on home
     * Wi-Fi, which may read the table read, control it and leave notes on its passages, and nothing else.
     */
    private async handle(method: string, path: string, body: any, browser = false): Promise<PhoneReply> {
        try { return await this.answer(method, path, body, browser); }
        catch { return { status: 400, body: { error: "Invalid phone request." } }; }
    }
    private async answer(method: string, path: string, body: any, browser: boolean): Promise<PhoneReply> {
        const reply = (status: number, value: unknown): PhoneReply => ({ status, body: value });
        if (this.closed)
            return reply(410, { error: "Pairing ended." });
        if (body !== undefined && Buffer.byteLength(JSON.stringify(body)) > 24000)
            return reply(400, { error: "Invalid phone request." });
        if (this.reportDevice) {
            try { await this.reportDevice(); }
            catch { return reply(503, { error: "The Mac could not save pairing activity. Keep this text and retry." }); }
        }
        if (browser && (path === "/api/device" || path === "/api/receipts" || body?.paragraphId !== undefined))
            return reply(404, { error: "Not found." });
        if (path === "/api/device") {
            if (method === "POST") {
                if (typeof body?.name !== "string" || !body.name.trim() || body.name.length > 100)
                    return reply(400, { error: "Invalid iPhone name." });
                try { await this.reportDevice?.(body.name); }
                catch { return reply(503, { error: "The Mac could not save the iPhone name. Retry shortly." }); }
            }
            return reply(200, { open: true });
        }
        if (method === "GET" && path === "/api/snapshot")
            return reply(200, this.snapshot);
        if (method === "GET" && path === "/api/receipts") {
            return reply(200, this.readDecisions?.() ?? Object.fromEntries(this.outcomes));
        }
        if (method !== "POST")
            return reply(404, { error: "Not found." });
        const anchored = path === "/api/inbox" && body?.paragraphId !== undefined;
        // A note may be loose: written on the phone without choosing a passage.
        if (anchored && (typeof body.paragraphId !== "string" || !body.paragraphId.trim() && body.kind !== "note"
            || body.paragraphId.length > 160 || typeof body.sourceText !== "string"
            || body.sourceText.length > 1500 || !["scene-after", "scene-end", "draft", "note", "dictation"].includes(body.kind))) {
            return reply(400, { error: "Invalid paragraph anchor." });
        }
        // A playback control names no passage, so a newer reading cannot misplace it.
        if (!anchored && path !== "/api/command" && body.revision !== this.snapshot.revision)
            return reply(409, { error: "The shared reading changed. Reload it before sending this item." });
        if (path === "/api/command") {
            if (!["pause", "resume", "previous", "next", "stop"].includes(body.command))
                return reply(400, { error: "Unknown playback control." });
            this.onCommand(body.command);
            return reply(200, { ok: true });
        }
        if (path === "/api/inbox") {
            if (!body || !["scene-after", "scene-end", "draft", "note", "dictation", "bookmark"].includes(body.kind)
                || typeof body.text !== "string" || !body.text.trim() || body.text.length > 20000
                || (!anchored && typeof body.cueId !== "string") || typeof body.id !== "string"
                || !/^[-\w]{12,80}$/.test(body.id)) {
                return reply(400, { error: "Invalid note or transcript." });
            }
            if (body.kind.startsWith("scene-")) {
                const message = JSON.stringify(["inklot-take-v1", this.shared ? this.deviceId : "", this.scriptId,
                    body.id, body.kind, body.text, body.paragraphId, body.sourceText]);
                const expected = createHmac("sha256", Buffer.from(this.tokenHash ?? digest(this.token), "hex")).update(message).digest();
                const supplied = typeof body.sig === "string" ? Buffer.from(body.sig, "base64url") : Buffer.alloc(0);
                if (!anchored || body.v !== 2 || supplied.toString("base64url") !== body.sig
                    || supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
                    return reply(403, { error: "Invalid scene suggestion signature." });
            }
            // A retry shares the same disk-write promise. Never acknowledge an in-flight write as saved.
            // Retain the receipt after desktop acknowledgement so a delayed retry cannot re-deliver it.
            const anchor = anchored ? [body.paragraphId, body.sourceText] : [body.cueId, body.revision];
            const signature = JSON.stringify([body.kind, body.text, anchor]);
            let delivery = this.deliveries.get(body.id);
            if (delivery && delivery.signature !== signature)
                return reply(409, { error: "That receipt ID was already used for different content." });
            if (!delivery) {
                if (!this.shared && (this.inbox.length + this.inFlight >= 100 || this.deliveries.size >= 1000))
                    return reply(409, { error: "The desktop inbox or pairing receipt limit is full. Review it and pair again." });
                const cue = anchored
                    ? { id: "", paragraphId: body.paragraphId, text: body.sourceText }
                    : this.snapshot.cues.find((cue) => cue.id === body.cueId);
                if (!cue) return reply(409, { error: "Select a current reading passage first." });
                const item: PhoneInbox = {
                    id: body.id, deviceId: this.deviceId, kind: body.kind, text: body.text,
                    cueId: cue.id, paragraphId: cue.paragraphId, revision: this.snapshot.revision,
                    created: new Date().toISOString(), sourceText: cue.text,
                };
                this.inFlight++;
                const promise = Promise.resolve().then(async () => {
                    await this.onInbox(item);
                    if (!this.closed && !this.shared) this.inbox.push(item);
                    return item;
                }).finally(() => { this.inFlight--; });
                delivery = { signature, contentHash: digest(phoneContent(item)), promise };
                this.deliveries.set(body.id, delivery);
            }
            try {
                const saved = await delivery.promise;
                if (this.shared) this.deliveries.delete(body.id);
                return reply(200, { id: saved.id });
            } catch (e) {
                if (this.deliveries.get(body.id) === delivery) this.deliveries.delete(body.id);
                if (e instanceof Error && e.message.includes("already used"))
                    return reply(409, { error: e.message });
                return reply(503, { error: "The desktop inbox could not be saved. Keep this text and retry." });
            }
        }
        return reply(404, { error: "Not found." });
    }
}
