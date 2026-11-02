import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as httpsServer, type Server as HttpsServer } from "node:https";
import { randomBytes } from "node:crypto";
import { createRelay, type Relay } from "@screenplay/relay";
import type { PhoneTls } from "./tls.ts";
import { digest } from "./devices.ts";
import { phonePage } from "./web.ts";

export type PhoneRoute = (req: IncomingMessage, res: ServerResponse) => Promise<void>;
/** One stable port serves device-specific HTTP credentials and separate read-only rooms. */
export class PhoneHost {
  private server?: Server;
  relay!: Relay;
  readonly routes = new Map<string, PhoneRoute>();
  origin = "";
  async start(address: string, hostname: string, port: number, tls?: PhoneTls) {
    const nonce = randomBytes(18).toString("base64url"), html = phonePage(nonce, !!tls);
    this.origin = `${tls ? "https" : "http"}://${hostname}:${port}`;
    const handle = async (req: IncomingMessage, res: ServerResponse) => {
      const json = (status: number, error: string) => {
        res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error }));
      };
      if (req.headers.host !== new URL(this.origin).host || req.headers.origin && req.headers.origin !== this.origin)
        return json(403, "Origin refused.");
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
    const handler = (req: IncomingMessage, res: ServerResponse) => { void handle(req, res); };
    this.server = tls ? httpsServer(tls.options, handler) : createServer(handler);
    this.server.requestTimeout = 10000;
    this.server.headersTimeout = 10000;
    this.server.maxConnections = 64;
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, address, () => { this.server!.off("error", reject); resolve(); });
    });
    const actual = this.server.address();
    if (actual && typeof actual !== "string") this.origin = `${tls ? "https" : "http"}://${hostname}:${actual.port}`;
    this.relay = await createRelay({ readerServer: this.server, readerWaitForRoom: true });
  }
  updateTls(tls: PhoneTls) { (this.server as HttpsServer).setSecureContext(tls.options); }
  async stop() {
    await this.relay?.close();
    this.routes.clear();
    this.server?.closeAllConnections();
    if (this.server) await new Promise<void>(resolve => this.server!.close(() => resolve()));
    this.server = undefined;
  }
}
