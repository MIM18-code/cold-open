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
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(`screenplay-relay: a co-writing relay for the screenwriting app

  --port, -p  port to listen on (default 4455)
  --host      address to bind (default 0.0.0.0, every interface)
  --ttl       seconds an empty room keeps its document (default 600)

Writers set the relay in Settings > Co-writing as ws://<this machine>:<port>.
Put it behind a TLS proxy (Caddy, nginx) and use wss:// when it is on the internet.`);
  process.exit(0);
}

const port = Number(values.port);
const ttl = Number(values.ttl);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Not a port: ${values.port}`);
if (!Number.isFinite(ttl) || ttl < 0) throw new Error(`Not a number of seconds: ${values.ttl}`);

const relay = await createRelay({
  port,
  host: values.host!,
  allowClaim: true,
  emptyRoomTtl: ttl * 1000,
  log: (message) => console.log(`${new Date().toISOString()} ${message}`),
});
console.log(`screenplay-relay listening on ws://${relay.host}:${relay.port}`);

const stop = async () => {
  await relay.close();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
