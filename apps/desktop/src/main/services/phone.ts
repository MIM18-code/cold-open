import { join } from "node:path";
import type { Invite } from "@screenplay/relay/protocol";
import { ReplayGuard } from "@screenplay/relay/sealed";
import { nodeLinkCrypto } from "@screenplay/relay/sealed-node";
import { PhoneDevices, outdatedPhone } from "../phone/devices.ts";
import { PhoneHost } from "../phone/host.ts";
import { FolderGuard, PhoneFolder } from "../phone/folder.ts";
import { importTakesFile, type TakesImportResult } from "../phone/takes.ts";
import { tailscaleCheck, tailscaleNetwork, tailscaleTls, type TailNetwork } from "../phone/tailscale.ts";
import type { PhoneSnapshot, PhoneTailscale } from "../../shared/channels/phone.ts";
import { phonePathKey } from "../phone/identity.ts";
import { PhoneInboxStore } from "../phone/inbox.ts";
import { createRequire } from "node:module";
import type { PhoneTls } from "../phone/tls.ts";
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
    native = require("electron") as Pick<typeof import("electron"), "clipboard" | "dialog" | "powerSaveBlocker">,
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
    // One replay guard per home Wi-Fi pairing for as long as the app runs, whichever route is answering it.
    const guards = new Map<string, ReplayGuard>();
    const guardFor = (id: string) => guards.get(id) ?? guards.set(id, new ReplayGuard(nodeLinkCrypto)).get(id)!;
    /** Remembered iPhones on this listener that no open script is serving, revoked ones included. */
    const idleRoutes = (host: PhoneHost) => {
        for (const device of devices.all().filter(d => d.address === host.address && !outdatedPhone(d) && !d.hostname === host.sealed))
            if (!remembered.has(device.id)) host.park(device, devices, guardFor(device.id));
    };
    const hostFor = async (address: string, hostname: string, tls?: PhoneTls) => {
        const key = `${address}:${tls ? "https" : "http"}`;
        if (hosts.has(key)) return hosts.get(key)!;
        if (hostStarts.has(key)) return hostStarts.get(key)!;
        const pending = (async () => {
            const host = new PhoneHost();
            try {
                await host.start(address, hostname, stablePort(), tls);
                hosts.set(key, host);
                idleRoutes(host);
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
    // Holds a power save blocker while the writer asked for it and an iPhone can reach this Mac. Called after
    // every change to sessions, remembered, the setting or quitting; it only touches powerSaveBlocker on a change.
    let blocker: number | undefined;
    const syncAwake = () => {
        const wanted = ctx.settings.get("phone.keepAwake") === true && !quitting && (sessions.size > 0 || remembered.size > 0);
        if (wanted && blocker === undefined) blocker = native.powerSaveBlocker.start("prevent-app-suspension");
        else if (!wanted && blocker !== undefined) {
            native.powerSaveBlocker.stop(blocker);
            blocker = undefined;
        }
    };
    const emit = (_id: number) => {
        syncAwake();
        ctx.broadcast("phone:sharing-changed");
    };
    const stop = async (id: number) => {
        try {
            generations.set(id, (generations.get(id) ?? 0) + 1);
            const session = sessions.get(id);
            sessions.delete(id);
            inboxTargets.delete(id);
            openScripts.delete(id);
            for (const [deviceId, connection] of remembered) {
                if (connection.windowId !== id) continue;
                remembered.delete(deviceId);
                // Let the Mac sleep as soon as nothing is shared, not after the servers have finished closing.
                syncAwake();
                await connection.server.stop();
            }
            syncAwake();
            await session?.server.stop();
            for (const host of hosts.values()) idleRoutes(host);
        } finally { syncAwake(); }
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
    const sessionKey = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    ctx.handle("phone:claim-key", async (event, key: unknown) => {
        // Only a random session key may be claimed. Path keys are hashes anyone can compute, so they come only from
        // phone:path-key, which needs the script open for writing.
        if (typeof key !== "string" || !sessionKey.test(key)) {
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
    // The inbox alone, without the network and Tailscale checks, so phone notes can be filed while the panel is closed.
    ctx.handle("phone:inbox", async (event, key: unknown) => {
        await ready;
        return typeof key === "string" && owns(event.sender, key) ? await store.list(key) : [];
    });
    ctx.handle("phone:status", async (event, key?: string, recheck = false) => {
        await ready;
        const session = sessions.get(event.sender.id);
        return {
            addresses: await networks(), active: !!session,
            liveRemembered: [...remembered.values()].some(c => c.windowId === event.sender.id), url: session?.url ?? "", pairing: session?.pairing,
            revision: session?.revision ?? "", urlEncrypted: session?.encrypted ?? false,
            expiresAt: session?.expiresAt ?? null,
            keepAwake: ctx.settings.get("phone.keepAwake") === true, awake: blocker !== undefined,
            tailscale: await setupCheck(recheck === true),
            remembered: devices.all().filter(d => !d.revoked && owns(event.sender, d.scriptId)).map(d => ({
                id: d.id, name: d.name, scriptId: d.scriptId, created: d.created, lastSeen: d.lastSeen,
                ...(outdatedPhone(d) ? { pairAgain: true } : {}),
                // Only a pairing made through Tailscale reaches this Mac away from its Wi-Fi.
                ...(d.hostname ? { tailscale: true } : {}),
            })), port: stablePort(), folderChosen: !!devices.folder(), folderError, connectionError,
            inbox: owns(event.sender, key) ? await store.list(key) : [],
        };
    });
    ctx.handle("phone:start", async (event, address: unknown, input: unknown, documentId: unknown, remember: unknown = false, browser: unknown = false) => {
        await ready;
        const window = ctx.windowOf(event.sender), snapshot = validateSnapshot(input), id = event.sender.id;
        const network = (await networks()).find(a => a.address === address);
        if (!window || typeof address !== "string" || !network)
            throw new Error("Choose an available private-network or Tailscale address.");
        if (typeof remember !== "boolean") throw new Error("Choose whether to remember this iPhone.");
        const tail = "tailscale" in network ? network as TailNetwork : undefined;
        // Home Wi-Fi only, one-off only: the Safari page cannot use the sealed link, so its own link is plain HTTP.
        if (typeof browser !== "boolean" || browser && (tail || remember))
            throw new Error("A Safari link without encryption is only for a one-off pairing on home Wi-Fi.");
        if (remember && !/^[a-f0-9]{64}$/.test(String(documentId)))
            throw new Error("Save the script before remembering this iPhone, so it can follow the same script after restart.");
        if (!owns(event.sender, documentId))
            throw new Error("A document identity is required for the saved inbox.");
        if (sessions.has(id) || starting.has(id))
            throw new Error("Stop this window’s existing phone link first.");
        // Claimed before the certificate wait, so a second start in the meantime is refused.
        starting.add(id);
        const target = { documentId };
        inboxTargets.set(id, target);
        const generation = generations.get(id) ?? 0;
        let server: PhoneServer | undefined, deviceId: string | undefined;
        try {
            // Tailscale gets HTTPS with its own certificate. Home Wi-Fi gets a sealed link keyed from the pairing code.
            const tls = tail ? await tailscaleTls(ctx.paths.userData, tail) : undefined;
            const protection = browser
                ? `The link to the iPhone app is encrypted. The Safari link is not: anyone on this Wi-Fi could read the ${snapshot.cues.length} table-read passages it shows. `
                : "The link is encrypted. ";
            const answer = await dialog.showMessageBox(window, {
                type: "warning", message: "Share this live screenplay with your iPhone?",
                detail: `A paired phone can read “${snapshot.title}” as you write. ${protection}` +
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
                const created = await devices.create(documentId, address, tail?.hostname);
                deviceId = created.device.id;
                info = server.attach(host, created.device, created.token,
                    name => reportDevice(deviceId!, name), () => devices.decisions(deviceId!), guardFor(deviceId));
                remembered.set(deviceId, { server, windowId: id, publisher: info.publisher });
                openScripts.set(id, { documentId, snapshot });
                scriptsChanged();
            } else info = await server.start(address, tls, () => {
                if (sessions.get(id)?.server === server) {
                    sessions.delete(id);
                    inboxTargets.delete(id);
                    emit(id);
                }
            }, undefined, tail?.hostname ?? address, browser);
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
            // A failure after the link was registered must not leave its stopped server behind.
            if (server && sessions.get(id)?.server === server) { sessions.delete(id); emit(id); }
            throw e;
        }
        finally {
            starting.delete(id);
            if (inboxTargets.get(id) === target && !sessions.has(id)) inboxTargets.delete(id);
            syncAwake();
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
    ctx.handle("phone:set-keep-awake", (_event, value: unknown) => {
        if (typeof value !== "boolean") throw new Error("Choose whether to keep this Mac awake.");
        // Settings.set changes its value before it writes the file, so re-check even when the write throws.
        try { ctx.settings.set("phone.keepAwake", value); }
        finally { syncAwake(); }
        ctx.broadcast("phone:sharing-changed");
    });
    ctx.handle("phone:detach", event => stop(event.sender.id));
    // Stop sharing ends this window's one-off link only. Remembered iPhones stay paired and connected; Revoke
    // beside a device removes it.
    ctx.handle("phone:stop", async event => {
        const id = event.sender.id, session = sessions.get(id);
        if (session?.deviceId) return;
        // Also cancels a pairing whose confirmation is still open.
        generations.set(id, (generations.get(id) ?? 0) + 1);
        if (!session) return;
        sessions.delete(id);
        inboxTargets.delete(id);
        try {
            syncAwake();
            await session.server.stop();
        } finally { syncAwake(); }
        emit(id);
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
        if (kind === "browser" && !session.url) throw new Error("This pairing has no Safari link.");
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
        // Windows that skipped publishing because nothing was shared start publishing to the folder.
        ctx.broadcast("phone:sharing-changed");
    });
    ctx.handle("phone:revoke", async (event, id: unknown) => {
        await ready;
        const device = typeof id === "string" ? devices.device(id) : undefined;
        if (!device || !owns(event.sender, device.scriptId)) throw new Error("Open the paired script before revoking its iPhone.");
        await devices.revoke(device.id);
        const connection = remembered.get(device.id);
        remembered.delete(device.id);
        syncAwake();
        try {
            for (const host of hosts.values()) host.routes.delete(device.tokenHash);
            await connection?.server.stop(true);
            for (const host of hosts.values()) idleRoutes(host);
            for (const [windowId, session] of sessions) {
                if (session.deviceId === device.id) { sessions.delete(windowId); inboxTargets.delete(windowId); }
            }
        } finally { syncAwake(); }
        if (!devices.all().some(d => !d.revoked && !outdatedPhone(d))) connectionError = "";
        ctx.broadcast("phone:sharing-changed");
    });
    ctx.handle("phone:resume", async (event, key: unknown, input: unknown) => {
        await restore;
        if (!owns(event.sender, key)) throw new Error("Open the script before resuming its iPhone.");
        const snapshot = validateSnapshot(input), window = ctx.windowOf(event.sender);
        if (!window) return { publishers: [] };
        // The first save of an untitled script moves its inbox, and with it the one-off link, to the path key.
        // That is the same document, so the link stays. Save As or another script ends it.
        const previous = openScripts.get(event.sender.id), session = sessions.get(event.sender.id);
        const firstSave = !!previous && sessionKey.test(previous.documentId) && !!session && !session.deviceId
            && session.documentId === key;
        if (previous && previous.documentId !== key && !firstSave) await stop(event.sender.id);
        if (event.sender.isDestroyed()) return { publishers: [] };
        const opened = { documentId: key, snapshot };
        openScripts.set(event.sender.id, opened);
        scriptsChanged();
        // Before attaching, so a window that closes after an attach failed part-way still releases what did attach.
        trackWindow(event.sender);
        try {
            for (const device of devices.all().filter(d => !d.revoked && d.scriptId === key && !outdatedPhone(d))) {
                if (remembered.has(device.id)) continue;
                const host = hosts.get(`${device.address}:${device.hostname ? "https" : "http"}`);
                if (!host) continue;
                const server = new PhoneServer(snapshot, command => ctx.send(window, "phone:command", command), async item => {
                    await devices.receive(device.id, key, item, store);
                    ctx.send(window, "phone:inbox-changed");
                });
                const { publisher } = server.attach(host, device, undefined,
                    name => reportDevice(device.id, name), () => devices.decisions(device.id), guardFor(device.id));
                remembered.set(device.id, { server, windowId: event.sender.id, publisher });
            }
        } finally { syncAwake(); }
        await publish(event.sender.id, opened);
        const live = sessions.get(event.sender.id);
        return { publishers: openScripts.get(event.sender.id)?.documentId === key
            ? [...remembered].filter(([id, connection]) => connection.windowId === event.sender.id
                && devices.device(id)?.scriptId === key).map(([, connection]) => connection.publisher) : [],
            // What the renderer needs to skip background publishing when nothing would receive it, and to offer
            // Stop One-Off Phone Link only for a one-off link.
            // The folder writer writes only for this script's paired iPhones.
            shared: !!live || [...remembered.values()].some(c => c.windowId === event.sender.id)
                || !!folder && devices.all().some(d => !d.revoked && d.scriptId === key),
            oneOff: !!live && !live.deviceId };
    });
    /** Starts missing listeners. Resolves true when a listener started or the connection error changed. */
    const restoreHosts = async () => {
        const before = connectionError;
        let started = false;
        // One message for the pass: the first iPhone that could not resume. A later one that did must not hide it.
        let failed = "";
        // An iPhone paired on home Wi-Fi by an earlier version gets no listener: it must be paired again.
        const active = devices.all().filter(d => !d.revoked && !outdatedPhone(d));
        for (const device of active) {
            try {
                if (hosts.has(`${device.address}:${device.hostname ? "https" : "http"}`)) continue;
                let tls;
                if (device.hostname) {
                    const tail = await detectTailscale();
                    if (!tail || tail.hostname !== device.hostname || tail.address !== device.address)
                        throw new Error("Reconnect this Mac to its paired Tailscale network to resume the iPhone.");
                    tls = await tailscaleTls(ctx.paths.userData, tail);
                }
                await hostFor(device.address, device.hostname ?? device.address, tls);
                started = true;
            } catch (e) { failed ||= String(e); }
        }
        // A pass that tried nothing leaves the message alone while remembered iPhones exist: it may be a certificate
        // renewal's, set elsewhere. Once no active remembered iPhone remains, clear it.
        if (failed) connectionError = failed;
        else if (started || !active.length) connectionError = "";
        return started || connectionError !== before;
    };
    const restore = ready.then(async () => { await startFolder(); await restoreHosts(); })
        .catch(e => { connectionError = String(e); })
        .finally(() => ctx.broadcast("phone:sharing-changed"));
    let restoring = false;
    const retry = setInterval(() => {
        if (restoring) return;
        restoring = true;
        // Every window refreshes its status on this broadcast, which runs the Tailscale CLI, so only send it on a change.
        void ready.then(restoreHosts).then(changed => { if (changed) ctx.broadcast("phone:sharing-changed"); })
            .catch(e => { connectionError = String(e); }).finally(() => { restoring = false; });
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
        syncAwake();
        scriptsChanged();
        clearInterval(retry); clearInterval(renewal);
        await restore;
        await folder?.stop();
        await Promise.allSettled([...new Set([...sessions.keys(), ...openScripts.keys()])].map(stop));
        await Promise.allSettled([...hosts.values()].map(h => h.stop()));
        await store.flush(); await devices.flush();
    });
}
