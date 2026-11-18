import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as httpsServer, type Server as HttpsServer } from "node:https";
import { randomBytes } from "node:crypto";
import { createRelay, type Relay } from "@screenplay/relay";
import type { PhoneTls } from "./tls.ts";
import { ReplayGuard, fromBase64url, linkKeys } from "@screenplay/relay/sealed";
import { nodeLinkCrypto } from "@screenplay/relay/sealed-node";
import { digest, type PhoneDevices, type RememberedPhone } from "./devices.ts";
import { serveLink, type PhoneLink } from "./link.ts";
import { phonePage } from "./web.ts";

export type PhoneRoute = (req: IncomingMessage, res: ServerResponse) => Promise<void>;
/**
 * One stable port serves every remembered iPhone on an interface, each with its own credentials and read-only room.
 * Over Tailscale the listener is HTTPS and an iPhone presents its bearer. On home Wi-Fi the listener is plain HTTP
 * and takes only sealed requests: no page, no bearer, no readable room key.
 */
export class PhoneHost {
  private server?: Server;
  relay!: Relay;
  /** HTTPS: the SHA-256 of a bearer to what answers it. */
  readonly routes = new Map<string, PhoneRoute>();
  /** Home Wi-Fi: a pairing ID to its sealed link. */
  readonly links = new Map<string, PhoneLink>();
  origin = "";
  address = "";
  sealed = false;
  async start(address: string, hostname: string, port: number, tls?: PhoneTls) {
    const nonce = randomBytes(18).toString("base64url"), html = phonePage(nonce, !!tls);
    this.address = address;
    this.sealed = !tls;
    this.origin = `${tls ? "https" : "http"}://${hostname}:${port}`;
    const handle = async (req: IncomingMessage, res: ServerResponse) => {
      const json = (status: number, error: string) => {
        res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error }));
      };
      if (req.headers.host !== new URL(this.origin).host || req.headers.origin && req.headers.origin !== this.origin)
        return json(403, "Origin refused.");
      if (this.sealed) {
        if (req.method === "POST" && req.url === "/link") return serveLink(req, res, id => this.links.get(id));
        return json(404, "Not found.");
      }
      if (req.method === "GET" && req.url === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
          "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
          "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; ` +
            "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
        res.end(html);
        return;
      }
      const auth = req.headers.authorization;
      const route = typeof auth === "string" && auth.startsWith("Bearer ") ? this.routes.get(digest(auth.slice(7))) : undefined;
      if (!route) return json(403, "This Mac revoked the pairing");
      try { await route(req, res); } catch { json(400, "Invalid phone request."); }
    };
    const handler = (req: IncomingMessage, res: ServerResponse) => {
      void handle(req, res).catch(() => { if (res.headersSent) res.destroy(); else res.writeHead(400).end(); });
    };
    this.server = tls ? httpsServer(tls.options, handler) : createServer(handler);
    this.server.requestTimeout = 10000;
    this.server.headersTimeout = 10000;
    this.server.maxConnections = 64;
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, address, () => { this.server!.off("error", reject); resolve(); });
    });
    // A listening server can still report an accept error; unheard, it would be an uncaught exception in the app.
    this.server.on("error", () => {});
    const actual = this.server.address();
    if (actual && typeof actual !== "string") this.origin = `${tls ? "https" : "http"}://${hostname}:${actual.port}`;
    this.relay = await createRelay({ readerServer: this.server, readerWaitForRoom: true,
      ...(this.sealed ? { readerSealed: (id: string) => this.links.get(id)?.keys } : {}) });
  }
  /**
   * Answer a remembered iPhone that no open script is serving: its receipts, "the script is not open", or, once it
   * is revoked, a refusal. On home Wi-Fi the refusal is sealed like any answer, so the iPhone can tell the Mac's
   * word from anyone else's on the network.
   */
  park(device: RememberedPhone, devices: Pick<PhoneDevices, "seen" | "decisions">, guard = new ReplayGuard(nodeLinkCrypto)) {
    const idle = async (method: string, path: string) => {
      await devices.seen(device.id);
      const receipts = method === "GET" && path === "/api/receipts", status = method === "GET" && path === "/api/device";
      return { status: receipts || status ? 200 : 503, body: receipts ? devices.decisions(device.id) : status ? { open: false }
        : { error: "The paired script is not open on the Mac. Keep queueing." } };
    };
    if (device.root) {
      const keys = linkKeys(nodeLinkCrypto, fromBase64url(device.root));
      this.links.set(keys.id, { keys, guard, handle: async request => device.revoked
        ? { status: 403, body: { error: "This Mac revoked the pairing" } }
        : idle(request.m, request.p).catch(() => ({ status: 503, body: { error: "The Mac could not save pairing activity. Retry shortly." } })) });
    } else if (!device.revoked) {
      this.routes.set(device.tokenHash, async (req, res) => {
        const reply = await idle(req.method ?? "", req.url ?? "");
        res.writeHead(reply.status, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(reply.body));
      });
    }
  }
  updateTls(tls: PhoneTls) { (this.server as HttpsServer).setSecureContext(tls.options); }
  async stop() {
    await this.relay?.close();
    this.routes.clear();
    this.links.clear();
    this.server?.closeAllConnections();
    if (this.server) await new Promise<void>(resolve => this.server!.close(() => resolve()));
    this.server = undefined;
  }
}
