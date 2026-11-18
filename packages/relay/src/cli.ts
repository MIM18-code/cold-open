#!/usr/bin/env node
// Self-hosted relay: `npx screenplay-relay --port 4455`. A room opens when a writer connects with the key its name is
// derived from, and is dropped after it sits empty for --ttl seconds. Nothing is written to disk and keys are never logged.
import { parseArgs } from "node:util";

import { createRelay } from "./relay.ts";

const { values } = parseArgs({
  options: {
    port: { type: "string", short: "p", default: "4455" },
    host: { type: "string", default: "0.0.0.0" },
    ttl: { type: "string", default: "600" },
    "max-rooms": { type: "string", default: "20" },
    "max-connections": { type: "string", default: "100" },
    "max-doc-mb": { type: "string", default: "8" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(`screenplay-relay: a co-writing relay for the screenwriting app

  --port, -p         port to listen on (default 4455)
  --host             address to bind (default 0.0.0.0, every interface)
  --ttl              seconds an empty room keeps its document (default 600)
  --max-rooms        rooms open at once (default 20)
  --max-connections  writers and readers connected at once, across all rooms (default 100)
  --max-doc-mb       largest script a room holds, in MiB (default 8)

0 turns a limit off. Each connection may also speak for 8 presences of up to 64 KiB.

An ordinary script uses a few MiB. A document built to be expensive can take about
20 times max-doc-mb of memory, and each connection can hold about 16 MiB plus one
script of unread answers, so the defaults bound a deliberate attack at about 7.5 GB
(4 GB of documents, 3.5 GB of connection buffers). Run the relay under a container
or process memory limit. On a small box lower all three limits; the README shows
the arithmetic.

Writers set the relay in Settings > Co-writing as ws://<this machine>:<port>.
Put it behind a TLS proxy (Caddy, nginx) and use wss:// when it is on the internet.`);
  process.exit(0);
}

const port = Number(values.port);
const ttl = Number(values.ttl);
const maxRooms = Number(values["max-rooms"]);
const maxConnections = Number(values["max-connections"]);
const maxDocMb = Number(values["max-doc-mb"]);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Not a port: ${values.port}`);
if (!Number.isFinite(ttl) || ttl < 0) throw new Error(`Not a number of seconds: ${values.ttl}`);
if (!Number.isInteger(maxRooms) || maxRooms < 0) throw new Error(`Not a number of rooms: ${values["max-rooms"]}`);
if (!Number.isInteger(maxConnections) || maxConnections < 0) throw new Error(`Not a number of connections: ${values["max-connections"]}`);
if (!Number.isFinite(maxDocMb) || maxDocMb < 0) throw new Error(`Not a size in MiB: ${values["max-doc-mb"]}`);

const MiB = 1024 * 1024;
const maxDocBytes = maxDocMb ? Math.floor(maxDocMb * MiB) : undefined;
const relay = await createRelay({
  port,
  host: values.host!,
  allowClaim: true,
  emptyRoomTtl: ttl * 1000,
  ...(maxRooms ? { maxRooms } : {}),
  ...(maxConnections ? { maxConnections } : {}),
  // A writer's first sync sends the whole script in one message, so the message limit sits just above the document limit.
  ...(maxDocBytes ? { maxDocBytes, maxPayload: maxDocBytes + MiB } : {}),
  // A real client speaks for one presence: a name, a color and a cursor.
  maxAwarenessBytes: 64 * 1024,
  maxAwarenessClients: 8,
  log: (message) => console.log(`${new Date().toISOString()} ${message}`),
});
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const limits = [
  maxRooms ? plural(maxRooms, "room") : "no room limit",
  maxConnections ? plural(maxConnections, "connection") : "no connection limit",
  maxDocBytes ? `${maxDocMb} MiB per script` : "no document limit",
];
console.log(`screenplay-relay listening on ws://${relay.host}:${relay.port} (${limits.join(", ")})`);

const stop = async () => {
  await relay.close();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
