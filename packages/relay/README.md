# @screenplay/relay

A small WebSocket relay for live co-writing, plus the client the screenwriting app uses. It speaks the standard y-websocket protocol (sync, awareness, query-awareness) with rooms, a read-write key per room and a derived read-only key that can follow along but never edit. MIT licensed.

The desktop app runs one of these inside itself when a writer shares a script on their network. Run your own to write together across the internet:

```bash
npx screenplay-relay --port 4455          # from a clone of this repo, after npm install
node packages/relay/src/cli.ts --port 4455 --host 0.0.0.0 --ttl 600 --max-rooms 50 --max-connections 200 --max-doc-mb 8
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

`@screenplay/relay/sealed` is the sealed link the paired iPhone uses on home Wi-Fi: HKDF-SHA256 keys from a secret both ends already hold, XChaCha20-Poly1305 around every HTTP body and relay message, and replay rejection, with no certificate. `createRelay({ readerServer, readerSealed })` makes a reader listener accept only sealed connections, and `sealedWebSocket(keys)` is the matching `WebSocket` class for `RelayClient`. It uses no Node APIs. The format is in `docs/sync-protocol.md` under "Sealed link".

```bash
npm test         # real sockets on 127.0.0.1
npm run typecheck
```

The package runs from TypeScript source on Node 22.18 or later (type stripping); there is no compiled build for publishing to npm yet.

## Limits

Anyone who can reach the relay can open a room with a key they made up, so the command-line relay caps what one visitor can take:

| Flag | Option | CLI default | Limits |
| --- | --- | --- | --- |
| `--max-rooms` | `maxRooms` | 20 | Rooms open at once, including empty rooms waiting out `--ttl`. |
| `--max-connections` | `maxConnections` | 100 | Writers and readers connected at once, across all rooms. |
| `--max-doc-mb` | `maxDocBytes` (in bytes) | 8 MiB | One room's script, measured as its encoded Yjs state. |

The CLI also caps presence, without flags: each connection may speak for 8 client IDs (`maxAwarenessClients`), with awareness updates of up to 64 KiB (`maxAwarenessBytes`). A real client speaks for one ID, and its state is a name, a color and a cursor. A connection past either cap is closed with 4400 and its presence removed.

On the command line `0` turns a limit off. In `createRelay` an option left out means no limit, which is how the desktop app's built-in relay runs. With a document limit set, the CLI accepts messages up to the limit plus 1 MiB, because a writer's first sync sends the whole script in one message; without one it accepts up to 32 MiB.

A writer or reader who arrives when the relay is full is refused with close code 4429 and the reason "the relay is full". The client keeps retrying and gets in when a room or connection frees up. A writer whose change would push the script past the document limit is disconnected with 4413, "the script is too large for this relay", and does not reconnect. The change is not applied, and everyone else in the room stays connected. A single message past the message limit ends the same way, with the WebSocket code 1009 instead of 4413.

The relay measures a room's document once per sixteenth of the limit in incoming changes, and tries any single change that large on a copy first. Between measurements, small changes that delete scattered characters can take a room up to about a third past the limit.

To size the limits, add two things. An ordinary script uses a few MiB of either.

- **Documents:** rooms × script limit × about 20. A document built to be expensive takes about 20 bytes of memory per byte of script, and a room can run up to a third over its limit between measurements. At the defaults: 20 × 8 MiB × 1.3 × 20, about 4 GB.
- **Connections:** connections × (16 MiB + script limit), plus one incoming message each. The relay stops answering a peer that has more than 16 MiB unread, but one more answer, up to a whole script, still goes out, and each connection can be sending one message of up to the message limit. At the defaults: 100 × 24 MiB of unread answers, about 2.4 GB, plus 100 × 9 MiB arriving, about 0.9 GB.

So a deliberate attack at the defaults is bounded at about 7.5 GB. An honest session uses a small fraction of that. Run the relay under a memory limit, and use a container or process limit for it: `node --max-old-space-size` covers the documents but not the connection buffers, which sit outside the JavaScript heap. On a small box lower `--max-rooms` and `--max-doc-mb` to shrink the first figure and `--max-connections` to shrink the second; `--max-rooms 4 --max-connections 20 --max-doc-mb 4` bounds it near 1 GB.
