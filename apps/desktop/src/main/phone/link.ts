import type { IncomingMessage, ServerResponse } from "node:http";
import { LinkError, ReplayGuard, answerSealed, requestId, type LinkKeys, type LinkRequest } from "@screenplay/relay/sealed";

export interface PhoneReply { status: number; body: unknown; }
/** One pairing on a home Wi-Fi listener: its keys, the requests it has already seen, and what answers it. */
export interface PhoneLink {
  keys: LinkKeys;
  guard: ReplayGuard;
  handle(request: LinkRequest, remote: string): Promise<PhoneReply>;
}

// A 24,000-byte JSON body, its envelope, and base64.
const LIMIT = 36_000;

/**
 * Answer POST /link. The body is a sealed request and the answer a sealed response, both text. A request that
 * names no pairing here, does not authenticate or was seen before gets the same bare refusal in the clear: the
 * phone does not act on it, so it tells someone on the network nothing and lets them forge nothing.
 */
export async function serveLink(req: IncomingMessage, res: ServerResponse, find: (id: string) => PhoneLink | undefined): Promise<void> {
  const refuse = (status = 403) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify({ error: "Pairing refused." }));
  };
  if (Number(req.headers["content-length"] ?? 0) > LIMIT) return refuse(413);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of req) {
    const chunk = Buffer.from(part);
    size += chunk.length;
    if (size > LIMIT) return refuse(413);
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString("latin1");
  const link = find(requestId(body) ?? "");
  if (!link) return refuse();
  let sealed: string;
  try {
    sealed = await answerSealed(link.keys, link.guard, body, request => link.handle(request, req.socket.remoteAddress ?? ""));
  } catch (e) {
    if (e instanceof LinkError) return refuse();
    throw e;
  }
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(sealed);
}
