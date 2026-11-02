# @screenplay/relay

A small WebSocket relay for live co-writing, plus the client the screenwriting app uses. It speaks the standard y-websocket protocol (sync, awareness, query-awareness) with rooms, a read-write key per room and a derived read-only key that can follow along but never edit. MIT licensed.

The desktop app runs one of these inside itself when a writer shares a script on their network. Run your own to write together across the internet:

```bash
npx screenplay-relay --port 4455          # from a clone of this repo, after npm install
node packages/relay/src/cli.ts --port 4455 --host 0.0.0.0 --ttl 600
```

Then set Settings > Co-writing > Self-hosted relay to `ws://<machine>:4455`, or `wss://…` behind a TLS proxy such as Caddy. A room opens when a writer connects with the read-write key its name is derived from (a read-only key never opens one); empty rooms are dropped after `--ttl` seconds. Nothing is stored on disk and keys are never logged.

```ts
import { createRelay } from "@screenplay/relay";
import { RelayClient } from "@screenplay/relay/client";
import { parseInvite } from "@screenplay/relay/protocol";

const relay = await createRelay({ host: "0.0.0.0", port: 0 });
const { room, key, readKey } = relay.createRoom();

const invite = parseInvite(text);
const client = new RelayClient({ relay: invite.relay, room: invite.room, key: invite.key, doc: ydoc, readOnly: invite.readOnly });
await client.whenSynced();
```

The wire protocol, invite format, keys and read-only rules are in `docs/sync-protocol.md`.

```bash
npm test         # real sockets on 127.0.0.1
npm run typecheck
```

The package runs from TypeScript source on Node 22.18 or later (type stripping); there is no compiled build for publishing to npm yet.
