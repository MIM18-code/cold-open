import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Invite } from "@screenplay/relay/protocol";
import { PhoneDevices } from "../phone/devices.ts";
import { PhoneHost } from "../phone/host.ts";
import { FolderGuard, PhoneFolder } from "../phone/folder.ts";
import { importTakesFile, type TakesImportResult } from "../phone/takes.ts";
import { tailscaleCheck, tailscaleNetwork, tailscaleTls, type TailNetwork } from "../phone/tailscale.ts";
import { replaceFile } from "../safe-fs.ts";
import type { PhoneSnapshot, PhoneTailscale } from "../../shared/channels/phone.ts";
import { phonePathKey } from "../phone/identity.ts";
import { PhoneInboxStore } from "../phone/inbox.ts";
import { createRequire } from "node:module";
import { openForRead } from "../safe-fs.ts";
import { phoneTls, type PhoneCertificateInfo } from "../phone/tls.ts";
import type { ServiceContext } from "../context.ts";
import { PhoneServer, lanAddresses, validateSnapshot } from "../phone/server.ts";
const require = createRequire(import.meta.url);

let openTakes: ((path: string) => Promise<TakesImportResult>) | undefined;
/** Import a `.coldopentakes` file the writer opened in Finder. Set once the phone service is registered. */
export function openTakesFile(path: string): Promise<TakesImportResult> {
    if (!openTakes) return Promise.reject(new Error("The phone companion is still starting. Open the file again in a moment."));
    return openTakes(path);
}

export function register(ctx: ServiceContext,
    native = require("electron") as Pick<typeof import("electron"), "clipboard" | "dialog">,
    detectTailscale = tailscaleNetwork,
    checkTailscale: () => Promise<PhoneTailscale> = tailscaleCheck): void {
    const { clipboard, dialog } = native;
    const store = new PhoneInboxStore(join(ctx.paths.userData, "phone-inbox"));
    const devices = new PhoneDevices(join(ctx.paths.userData, "phone-devices.json"));
    const ready = devices.load().then(() => devices.migrateInbox(store));
    const hosts = new Map<string, PhoneHost>();
    const hostStarts = new Map<string, Promise<PhoneHost>>();
    const remembered = new Map<string, { server: PhoneServer; windowId: number; publisher: Invite }>();
    const openScripts = new Map<number, { documentId: string; snapshot: PhoneSnapshot }>();
    let folder: PhoneFolder | undefined, folderError = "", connectionError = "";
    let networkCache: Awaited<ReturnType<typeof tailscaleNetwork>> = null, networkChecked = 0;
    const networks = async () => {
        if (Date.now() - networkChecked > 5000) {
            networkCache = await detectTailscale(); networkChecked = Date.now();
        }
        const tail = networkCache;
        return [...(tail ? [tail] : []), ...lanAddresses()];
    };
    let tailCheck: PhoneTailscale | null = null, tailChecked = 0;
    const setupCheck = async (recheck: boolean) => {
        if (!recheck && tailCheck && Date.now() - tailChecked < 30000) return tailCheck;
        tailCheck = await checkTailscale().catch(() => ({ installed: false, running: false, magicDns: false, https: false }));
        tailChecked = Date.now();
        return tailCheck;
    };
    const scriptWaiters = new Set<() => void>();
    let quitting = false;
    const findScript = (scriptId: string) => {
        for (const opened of openScripts.values())
            if (opened.documentId === scriptId) return { title: opened.snapshot.title };
        return undefined;
    };
    const waitForScript = (scriptId: string): Promise<{ title: string } | undefined> => {
        const opened = findScript(scriptId);
        if (opened) return Promise.resolve(opened);
        return new Promise(resolve => {
            const finish = (script?: { title: string }) => {
                clearTimeout(timer);
                scriptWaiters.delete(check);
                resolve(script);
            };
            const check = () => {
                const script = findScript(scriptId);
                if (script || quitting) finish(script);
            };
            const timer = setTimeout(() => finish(), 15000);
            scriptWaiters.add(check);
        });
    };
    const scriptsChanged = () => { for (const check of scriptWaiters) check(); };
    openTakes = async (path: string) => {
        await ready;
        const result = await importTakesFile(path, devices, store, waitForScript);
        ctx.broadcast("phone:inbox-changed");
        ctx.broadcast("phone:takes-imported", { added: result.added, title: result.title, scriptId: result.scriptId });
        return result;
    };
    const stablePort = () => {
        const port = ctx.settings.get("phone.port") ?? 4456;
        if (!Number.isInteger(port) || (port as number) < 1024 || (port as number) > 65535)
            throw new Error("The phone port must be a number from 1024 to 65535.");
        return port as number;
    };
    const idleRoutes = (host: PhoneHost, address: string) => {
        for (const device of devices.all().filter(d => !d.revoked && d.address === address)) {
            if (remembered.has(device.id)) continue;
            host.routes.set(device.tokenHash, async (req, res) => {
                await devices.seen(device.id);
                const receipts = req.method === "GET" && req.url === "/api/receipts";
                const status = req.url === "/api/device" && req.method === "GET";
                res.writeHead(receipts || status ? 200 : 503,
                    { "content-type": "application/json", "cache-control": "no-store" });
                res.end(JSON.stringify(receipts ? devices.decisions(device.id) : status ? { open: false }
                    : { error: "The paired script is not open on the Mac. Keep queueing." }));
            });
        }
    };
    const hostFor = async (address: string, hostname: string, tls?: ReturnType<typeof phoneTls>) => {
        const key = `${address}:${tls ? "https" : "http"}`;
        if (hosts.has(key)) return hosts.get(key)!;
        if (hostStarts.has(key)) return hostStarts.get(key)!;
        const pending = (async () => {
            const host = new PhoneHost();
            try {
                await host.start(address, hostname, stablePort(), tls);
                hosts.set(key, host);
                idleRoutes(host, address);
                return host;
            } catch (e) { await host.stop(); throw e; }
        })();
        hostStarts.set(key, pending);
        try { return await pending; } finally { hostStarts.delete(key); }
    };
    const startFolder = async () => {
        await folder?.stop(); folder = undefined; folderError = "";
        if (!devices.folder()) return;
        try {
            folder = new PhoneFolder(devices.folder()!.path, devices, store,
                () => ctx.broadcast("phone:inbox-changed"), message => { folderError = message; }, devices.folder());
            await folder.start();
            for (const opened of openScripts.values()) await folder.publish(opened.documentId, opened.snapshot);
        } catch (e) { folderError = String(e); }
    };
    const certificates = new Map<number, { cert: string; key: string; info: PhoneCertificateInfo }>();
    const reportDevice = async (id: string, name?: string) => {
        await devices.seen(id, name);
        if (name) ctx.broadcast("phone:sharing-changed");
    };
    const inboxTargets = new Map<number, { documentId: string }>();
    const sessionOwners = new WeakSet<object>();
    const trackWindow = (sender: Electron.WebContents) => {
        if (sessionOwners.has(sender)) return;
        sessionOwners.add(sender);
        sender.once("destroyed", () => { void stop(sender.id); });
    };
    const certificateOwners = new WeakSet<object>();
    const readPem = async (path: string, maximum: number) => {
        const file = await openForRead(path);
        if (!file) throw new Error("The chosen certificate file no longer exists.");
        try {
            if (file.info.size > maximum) throw new Error("The chosen certificate file is too large.");
            return new TextDecoder().decode(await file.read(maximum));
        } finally { await file.close(); }
    };
    const sessions = new Map<number, {
        server: PhoneServer;
        url: string;
        pairing: string;
        revision: string;
        title: string;
        documentId: string;
        encrypted: boolean;
        expiresAt: number | null;
        deviceId?: string;
    }>(), starting = new Set<number>(), generations = new Map<number, number>();
    const emit = (_id: number) => ctx.broadcast("phone:sharing-changed");
    const stop = async (id: number) => {
        generations.set(id, (generations.get(id) ?? 0) + 1);
        const session = sessions.get(id);
        sessions.delete(id);
        inboxTargets.delete(id);
        openScripts.delete(id);
        for (const [deviceId, connection] of remembered) {
            if (connection.windowId !== id) continue;
            remembered.delete(deviceId);
            await connection.server.stop();
        }
        await session?.server.stop();
        for (const host of hosts.values()) idleRoutes(host, new URL(host.origin).hostname.endsWith(".ts.net")
            ? devices.all().find(d => d.hostname === new URL(host.origin).hostname)?.address ?? ""
            : new URL(host.origin).hostname);
        emit(id);
    };
    // A window may use only the inbox keys it was given: the key of a script it has open, or a fresh key for an
    // untitled script. Path keys are guessable hashes, so the key alone must never open another script's inbox.
    const owned = new Map<number, Set<string>>();
    const own = (sender: Electron.WebContents, key: string) => {
        let keys = owned.get(sender.id);
        if (!keys) {
            keys = new Set();
            owned.set(sender.id, keys);
            sender.once("destroyed", () => owned.delete(sender.id));
        }
        keys.add(key);
        return key;
    };
    const owns = (sender: Electron.WebContents, key: unknown): key is string =>
        typeof key === "string" && !!owned.get(sender.id)?.has(key);
    ctx.handle("phone:path-key", (event, path: unknown) => {
        if (typeof path !== "string" || !ctx.isAllowedPath(path)) throw new Error("Open the script before using its phone inbox.");
        return own(event.sender, phonePathKey(path));
    });
    // Before path keys, a saved script's inbox was keyed by the random history ID stored in the script. Holding
    // that ID means holding the script, so a window with the script open for writing may fold that inbox into its
    // path key once.
    ctx.handle("phone:adopt-legacy-inbox", async (event, legacyKey: unknown, path: unknown) => {
        if (typeof path !== "string" || !ctx.isAllowedPath(path)) throw new Error("Open the script before using its phone inbox.");
        if (typeof legacyKey !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(legacyKey)) return;
        const key = own(event.sender, phonePathKey(path));
        if (!(await store.list(legacyKey)).length) return;
        await store.move(legacyKey, key, () => undefined);
        ctx.broadcast("phone:inbox-changed");
    });
    ctx.handle("phone:claim-key", async (event, key: unknown) => {
        // Only a random session key may be claimed. Path keys are hashes anyone can compute, so they come only from
        // phone:path-key, which needs the script open for writing.
        if (typeof key !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(key)) {
            throw new Error("Invalid inbox key.");
        }
        // An untitled script's key is new; an existing inbox belongs to some other script.
        if (!owns(event.sender, key) && (await store.list(key)).length) throw new Error("That phone inbox belongs to another script.");
        return own(event.sender, key);
    });
    ctx.handle("phone:move-inbox", async (event, from: unknown, to: unknown) => {
        if (!owns(event.sender, from) || !owns(event.sender, to)) throw new Error("Open the script before moving its phone inbox.");
        await ready;
        if (devices.all().some(d => !d.revoked && d.scriptId === from)) return;
        await store.move(from, to, (source, destination) => {
            const target = inboxTargets.get(event.sender.id);
            if (target?.documentId === source) target.documentId = destination;
        });
        ctx.broadcast("phone:inbox-changed");
    });
    ctx.handle("phone:clear-old-inboxes", async (event, key: unknown) => {
        const window = ctx.windowOf(event.sender);
        if (!window || !owns(event.sender, key)) {
            throw new Error("Choose a script first.");
        }
        const answer = await dialog.showMessageBox(window, {
            type: "warning", message: "Delete phone inboxes for other scripts?",
            detail: "This permanently deletes received notes and dictation for other scripts, including orphaned inboxes. " +
                "The current script and all active phone pairings are kept. Accepted project notes are unaffected.",
            buttons: ["Cancel", "Delete old inboxes"], defaultId: 0, cancelId: 0,
        });
        if (answer.response !== 1 || event.sender.isDestroyed()) return;
        await store.clearOther([key, ...devices.all().filter(d => !d.revoked).map(d => d.scriptId),
            ...[...sessions.values()].map(s => s.documentId)]);
        ctx.broadcast("phone:inbox-changed");
    });
    ctx.handle("phone:status", async (event, key?: string, recheck = false) => {
        await ready;
        const session = sessions.get(event.sender.id);
        return {
            addresses: await networks(), active: !!session,
            liveRemembered: [...remembered.values()].some(c => c.windowId === event.sender.id), url: session?.url ?? "", pairing: session?.pairing,
            revision: session?.revision ?? "", encrypted: session?.encrypted ?? false,
            expiresAt: session?.expiresAt ?? null, certificate: certificates.get(event.sender.id)?.info ?? null,
            tailscale: await setupCheck(recheck === true),
            remembered: devices.all().filter(d => !d.revoked && owns(event.sender, d.scriptId)).map(d => ({
                id: d.id, name: d.name, scriptId: d.scriptId, created: d.created, lastSeen: d.lastSeen,
            })), port: stablePort(), folderChosen: !!devices.folder(), folderError, connectionError,
            inbox: owns(event.sender, key) ? await store.list(key) : [],
        };
    });
    ctx.handle("phone:choose-tls", async (event, address: unknown) => {
        const window = ctx.windowOf(event.sender), id = event.sender.id;
        if (!window || typeof address !== "string" || !lanAddresses().some((a) => a.address === address))
            throw new Error("Choose an available private-network address first.");
        if (sessions.has(id) || starting.has(id)) throw new Error("Stop sharing before replacing its HTTPS identity.");
        const certificate = await dialog.showOpenDialog(window, { title: "Choose HTTPS server certificate (PEM)", properties: ["openFile"], filters: [{ name: "Certificate", extensions: ["pem", "crt"] }] });
        if (certificate.canceled || !certificate.filePaths[0] || event.sender.isDestroyed()) return null;
        const privateKey = await dialog.showOpenDialog(window, { title: "Choose matching HTTPS private key (PEM)", properties: ["openFile"], filters: [{ name: "Private key", extensions: ["pem", "key"] }] });
        if (privateKey.canceled || !privateKey.filePaths[0] || event.sender.isDestroyed()) return null;
        const cert = await readPem(certificate.filePaths[0], 256_000), key = await readPem(privateKey.filePaths[0], 32_000);
        const checked = phoneTls(cert, key, address);
        if (event.sender.isDestroyed()) return null;
        if (sessions.has(id) || starting.has(id)) throw new Error("Sharing started while the certificate dialog was open. Stop sharing and choose the certificate again.");
        certificates.set(id, { cert, key, info: checked.info });
        if (!certificateOwners.has(event.sender)) {
            certificateOwners.add(event.sender);
            event.sender.once("destroyed", () => certificates.delete(id));
        }
        return checked.info; // Private key and original file paths never enter the renderer or settings.
    });
    ctx.handle("phone:forget-tls", (event) => {
        if (sessions.has(event.sender.id) || starting.has(event.sender.id)) throw new Error("Stop sharing before forgetting its certificate.");
        certificates.delete(event.sender.id);
    });
    ctx.handle("phone:start", async (event, address: unknown, input: unknown, documentId: unknown, transport: unknown = "https", remember: unknown = false) => {
        await ready;
        const window = ctx.windowOf(event.sender), snapshot = validateSnapshot(input), id = event.sender.id;
        const network = (await networks()).find(a => a.address === address);
        if (!window || typeof address !== "string" || !network)
            throw new Error("Choose an available private-network or Tailscale address.");
        if (typeof remember !== "boolean") throw new Error("Choose whether to remember this iPhone.");
        const tail = "tailscale" in network ? network as TailNetwork : undefined;
        if (tail && transport !== "https") throw new Error("Tailscale requires HTTPS. No HTTP fallback is used.");
        if (remember && !/^[a-f0-9]{64}$/.test(String(documentId)))
            throw new Error("Save the script before remembering this iPhone, so it can follow the same script after restart.");
        if (!owns(event.sender, documentId))
            throw new Error("A document identity is required for the saved inbox.");
        if (sessions.has(id) || starting.has(id))
            throw new Error("Stop this window’s existing phone link first.");
        if (transport !== "https" && transport !== "http") throw new Error("Choose HTTPS or explicitly choose trusted-network HTTP.");
        const material = certificates.get(id);
        if (transport === "https" && !material && !tail) throw new Error("Choose an HTTPS certificate and its private key first. No unencrypted fallback is used.");
        const tls = tail ? await tailscaleTls(ctx.paths.userData, tail)
            : transport === "https" && material ? phoneTls(material.cert, material.key, address) : undefined;
        starting.add(id);
        const target = { documentId };
        inboxTargets.set(id, target);
        const generation = generations.get(id) ?? 0;
        let server: PhoneServer | undefined, deviceId: string | undefined;
        try {
            const protection = tls
                ? "HTTPS encrypts this session. The phone must trust the issuer of your certificate."
                : "You selected unencrypted HTTP. Use trusted private Wi-Fi only.";
            const answer = await dialog.showMessageBox(window, {
                type: "warning", message: "Share this live screenplay with your iPhone?",
                detail: `A paired phone can read “${snapshot.title}” as you write. The browser link shares ` +
                    `${snapshot.cues.length} captured table-read passages. ${protection} ` +
                    (remember ? "This iPhone follows this saved script until you revoke it. " : "Pairing expires after two hours. Stop sharing revokes both links. ") +
                    "Notes and dictated text stay in a local review inbox until you accept or discard them.",
                buttons: ["Cancel", "Start private-network link"], defaultId: 0, cancelId: 0,
            });
            if (answer.response !== 1 || event.sender.isDestroyed() || generation !== (generations.get(id) ?? 0))
                return null;
            server = new PhoneServer(snapshot, (command) => ctx.send(window, "phone:command", command), async (item) => {
                if (deviceId) await devices.receive(deviceId, target.documentId, item, store);
                else await store.append(() => target.documentId, item);
                ctx.send(window, "phone:inbox-changed");
            });
            let info;
            if (remember) {
                const host = await hostFor(address, tail?.hostname ?? address, tls);
                if (material && tls && !tail) {
                    for (const [extension, text] of [["crt", material.cert], ["key", material.key]]) {
                        const path = join(ctx.paths.userData, `phone-${address}.${extension}`);
                        await replaceFile(path, path + "." + randomUUID() + ".saving", text!, 0o600);
                    }
                }
                const created = await devices.create(documentId, address, tail?.hostname, !!tls);
                deviceId = created.device.id;
                info = server.attach(host, created.device, created.token,
                    name => reportDevice(deviceId!, name), () => devices.decisions(deviceId!));
                remembered.set(deviceId, { server, windowId: id, publisher: info.publisher });
                openScripts.set(id, { documentId, snapshot });
                scriptsChanged();
            } else info = await server.start(address, tls, () => {
                if (sessions.get(id)?.server === server) {
                    sessions.delete(id);
                    inboxTargets.delete(id);
                    emit(id);
                }
            }, undefined, tail?.hostname ?? address);
            if (event.sender.isDestroyed() || generation !== (generations.get(id) ?? 0)) {
                await server.stop();
                if (deviceId) { remembered.delete(deviceId); await devices.revoke(deviceId); }
                return null;
            }
            sessions.set(id, Object.assign(target, {
                server, deviceId, url: info.url, pairing: info.pairing, revision: snapshot.revision, title: snapshot.title,
                encrypted: info.encrypted, expiresAt: info.expiresAt,
            }));
            trackWindow(event.sender);
            emit(id);
            if (remember) await publish(id, openScripts.get(id)!);
            if (event.sender.isDestroyed() || generation !== (generations.get(id) ?? 0)) return null;
            return info;
        }
        catch (e) {
            await server?.stop();
            if (deviceId) { remembered.delete(deviceId); await devices.revoke(deviceId); }
            throw e;
        }
        finally {
            starting.delete(id);
            if (inboxTargets.get(id) === target && !sessions.has(id)) inboxTargets.delete(id);
        }
    });
    ctx.handle("phone:new-pairing", event => {
        const session = sessions.get(event.sender.id);
        if (session && !session.deviceId) throw new Error("Stop the one-off link before pairing another iPhone.");
        sessions.delete(event.sender.id);
        emit(event.sender.id);
    });
    ctx.handle("phone:set-port", async (_event, value: unknown) => {
        await ready;
        if (!Number.isInteger(value) || (value as number) < 1024 || (value as number) > 65535)
            throw new Error("The phone port must be a number from 1024 to 65535.");
        if (starting.size || devices.all().some(d => !d.revoked))
            throw new Error("Revoke remembered iPhones before changing their phone port.");
        await Promise.all([...hosts.values()].map(host => host.stop()));
        hosts.clear();
        ctx.settings.set("phone.port", value);
    });
    ctx.handle("phone:detach", event => stop(event.sender.id));
    ctx.handle("phone:stop", async event => {
        await ready;
        for (const [deviceId, connection] of remembered) {
            if (connection.windowId !== event.sender.id) continue;
            await devices.revoke(deviceId);
            await connection.server.stop(true);
            remembered.delete(deviceId);
        }
        await stop(event.sender.id);
    });
    const publish = async (id: number, opened: { documentId: string; snapshot: PhoneSnapshot }) => {
        if (openScripts.get(id) !== opened) return;
        const { documentId, snapshot } = opened, session = sessions.get(id);
        if (session?.documentId === documentId) {
            session.server.publish(snapshot); session.revision = snapshot.revision; session.title = snapshot.title;
        }
        for (const [deviceId, connection] of remembered) {
            if (connection.windowId === id && devices.device(deviceId)?.scriptId === documentId && connection.server !== session?.server)
                connection.server.publish(snapshot);
        }
        // All live recipients are checked before folder I/O can yield to a script switch.
        try { await folder?.publish(documentId, snapshot); } catch (e) { folderError = String(e); }
    };
    ctx.handle("phone:publish", async (event, input: unknown) => {
        const snapshot = validateSnapshot(input), opened = openScripts.get(event.sender.id);
        if (opened) {
            opened.snapshot = snapshot;
            await publish(event.sender.id, opened);
        } else {
            const session = sessions.get(event.sender.id);
            if (session) { session.server.publish(snapshot); session.revision = snapshot.revision; session.title = snapshot.title; }
        }
    });
    ctx.handle("phone:acknowledge", async (
        event, key: unknown, id: unknown, outcome: unknown = "ignored", deviceId: unknown = undefined,
    ) => {
        if (outcome !== "accepted" && outcome !== "ignored") throw new Error("Invalid receipt outcome.");
        if (!owns(event.sender, key) || typeof id !== "string") throw new Error("Invalid inbox item.");
        if (deviceId !== undefined && typeof deviceId !== "string") throw new Error("Invalid inbox item.");
        const item = (await store.list(key)).find(row => row.id === id && row.deviceId === deviceId);
        if (!item) return;
        await devices.decide(key, id, outcome, deviceId);
        await store.remove(key, id, deviceId);
        const active = sessions.get(event.sender.id);
        if (active?.documentId === key) active.server.acknowledge(id, outcome, deviceId ?? "");
        for (const [rememberedId, connection] of remembered) {
            if (rememberedId === deviceId && devices.device(rememberedId)?.scriptId === key)
                connection.server.acknowledge(id, outcome);
        }
    });
    ctx.handle("phone:copy-link", async (event, kind: unknown = "browser") => {
        const session = sessions.get(event.sender.id);
        if (!session) throw new Error("Start pairing first.");
        if (kind !== "browser" && kind !== "remote") throw new Error("Invalid pairing link type.");
        clipboard.writeText(kind === "remote" ? session.pairing : session.url);
    });
    ctx.handle("phone:choose-folder", async event => {
        const window = ctx.windowOf(event.sender);
        if (!window) return;
        const answer = await dialog.showOpenDialog(window, {
            title: "Choose the same iCloud Drive folder as on your iPhone", properties: ["openDirectory"],
        });
        if (answer.canceled || !answer.filePaths[0] || event.sender.isDestroyed()) return;
        await ready;
        // The path stays in main-only state and never grants renderer file access.
        const grant = new FolderGuard(answer.filePaths[0]).grant();
        await devices.setFolder(grant);
        await startFolder();
    });
    ctx.handle("phone:revoke", async (event, id: unknown) => {
        await ready;
        const device = typeof id === "string" ? devices.device(id) : undefined;
        if (!device || !owns(event.sender, device.scriptId)) throw new Error("Open the paired script before revoking its iPhone.");
        await devices.revoke(device.id);
        const connection = remembered.get(device.id);
        remembered.delete(device.id);
        for (const host of hosts.values()) host.routes.delete(device.tokenHash);
        await connection?.server.stop(true);
        for (const [windowId, session] of sessions) {
            if (session.deviceId === device.id) { sessions.delete(windowId); inboxTargets.delete(windowId); }
        }
        ctx.broadcast("phone:sharing-changed");
    });
    ctx.handle("phone:resume", async (event, key: unknown, input: unknown) => {
        await restore;
        if (!owns(event.sender, key)) throw new Error("Open the script before resuming its iPhone.");
        const snapshot = validateSnapshot(input), window = ctx.windowOf(event.sender);
        if (!window) return { publishers: [] };
        if (openScripts.get(event.sender.id)?.documentId !== key && openScripts.has(event.sender.id))
            await stop(event.sender.id);
        const opened = { documentId: key, snapshot };
        openScripts.set(event.sender.id, opened);
        scriptsChanged();
        for (const device of devices.all().filter(d => !d.revoked && d.scriptId === key)) {
            if (remembered.has(device.id)) continue;
            const host = hosts.get(`${device.address}:${device.encrypted ? "https" : "http"}`);
            if (!host) continue;
            const server = new PhoneServer(snapshot, command => ctx.send(window, "phone:command", command), async item => {
                await devices.receive(device.id, key, item, store);
                ctx.send(window, "phone:inbox-changed");
            });
            const { publisher } = server.attach(host, device, undefined,
                name => reportDevice(device.id, name), () => devices.decisions(device.id));
            remembered.set(device.id, { server, windowId: event.sender.id, publisher });
        }
        trackWindow(event.sender);
        await publish(event.sender.id, opened);
        return { publishers: openScripts.get(event.sender.id)?.documentId === key
            ? [...remembered].filter(([id, connection]) => connection.windowId === event.sender.id
                && devices.device(id)?.scriptId === key).map(([, connection]) => connection.publisher) : [] };
    });
    const restoreHosts = async () => {
        for (const device of devices.all().filter(d => !d.revoked)) {
            try {
                if (hosts.has(`${device.address}:${device.encrypted ? "https" : "http"}`)) continue;
                let tls;
                if (device.hostname) {
                    const tail = await detectTailscale();
                    if (!tail || tail.hostname !== device.hostname || tail.address !== device.address)
                        throw new Error("Reconnect this Mac to its paired Tailscale network to resume the iPhone.");
                    tls = await tailscaleTls(ctx.paths.userData, tail);
                } else if (device.encrypted) {
                    tls = phoneTls(await readPem(join(ctx.paths.userData, `phone-${device.address}.crt`), 256000),
                        await readPem(join(ctx.paths.userData, `phone-${device.address}.key`), 32000), device.address);
                }
                await hostFor(device.address, device.hostname ?? device.address, tls);
                connectionError = "";
            } catch (e) { connectionError = String(e); }
        }
        ctx.broadcast("phone:sharing-changed");
    };
    const restore = ready.then(async () => { await startFolder(); await restoreHosts(); })
        .catch(e => { connectionError = String(e); });
    let restoring = false;
    const retry = setInterval(() => {
        if (restoring) return;
        restoring = true;
        void ready.then(restoreHosts).catch(e => { connectionError = String(e); }).finally(() => { restoring = false; });
    }, 30000);
    retry.unref();
    const renewal = setInterval(() => {
        void (async () => {
            const tail = await detectTailscale();
            if (!tail) return;
            const host = hosts.get(`${tail.address}:https`);
            if (host) host.updateTls(await tailscaleTls(ctx.paths.userData, tail));
        })().catch(e => { connectionError = String(e); });
    }, 24 * 60 * 60 * 1000);
    renewal.unref();
    ctx.onQuit(async () => {
        quitting = true;
        scriptsChanged();
        clearInterval(retry); clearInterval(renewal);
        await restore;
        await folder?.stop();
        await Promise.allSettled([...new Set([...sessions.keys(), ...openScripts.keys()])].map(stop));
        await Promise.allSettled([...hosts.values()].map(h => h.stop()));
        await store.flush(); await devices.flush(); certificates.clear();
    });
}
