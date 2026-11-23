# Sync protocol

How the screenwriting app shares a script live (co-writing) and between a writer's own Macs (folder sync), written so Backlot and the phone remote can implement compatible clients. The reference code is MIT: `packages/relay` (relay server, client, invite helpers) and `apps/desktop/src/main/sync/folder-log.ts` (log format).

Both paths move the same thing: Yjs updates for the screenplay document described in `packages/engine/README.md`. Updates merge in any order and applying one twice changes nothing, so neither path needs locking or ordering.

## Live co-writing

### Topology

There is no hosted server. A session runs on one of two relays:

- **The host's Mac.** "Share for Co-writing…" starts a relay inside the desktop app's main process, bound to `0.0.0.0` on a port the OS picks. It runs only while at least one window is sharing and stops listening when the last one stops. Guests on the same network use the host’s local address. For writers on different networks, the panel offers an invite using the host’s Tailscale address once Tailscale is connected. A local invite is plain `ws://` with the room key in the URL, so it is readable to anyone on that network; Tailscale and `wss://` relays are encrypted. The paired phone's [sealed link](#sealed-link-home-wi-fi) is not yet used for co-writing.
- **A self-hosted relay.** `npx screenplay-relay --port 4455` (or `node packages/relay/src/cli.ts`). Writers enter its address under Settings > Co-writing; sharing then uses it instead of the embedded relay. Put it behind a TLS proxy and use `wss://` on the internet.

Everyone, the host included, is an ordinary client of the relay. The relay keeps a Y.Doc per room, so a writer who joins late gets the whole script from the relay even if no other writer is online. Nothing is written to disk.

### A Cold Open-operated relay (pilot proposal)

A writer would choose **Invite over the internet**. Cold Open would connect to one project-operated relay and copy an editing or reading link. Their co-writer would open the link and choose **Join**. Neither person would need a Tailscale account or a server address. Today, the host supplies a team relay address in Settings. The guest already gets everything needed from the link.

One always-on process can run the existing relay behind TLS. No database is needed for live rooms. Start with an existing MindInMotion server if it can accept secure WebSockets. An alternative for a small pilot is a single Render Starter instance, listed at $7/month for compute as of November 2, 2026, before bandwidth or other charges. Render's free instance can take around a minute to wake, longer than Cold Open's 15-second Join timeout. [WebSockets](https://render.com/docs/websocket), [pricing](https://render.com/pricing), [free service behavior](https://render.com/docs/free).

The self-hosted relay now caps rooms open at once (`--max-rooms`, default 20), connections across all rooms (`--max-connections`, default 100), the size of each room's script (`--max-doc-mb`, default 8) and each connection's presence (8 client IDs, 64 KiB per update). Ordinary scripts use a few megabytes each, but a document built to be expensive takes about 20 times its size in memory, a room can run up to a third past its limit between measurements, and each connection can hold about 16 MiB plus one script of unread answers. So the defaults bound a deliberate attack at about 7.5 GB (the arithmetic is in `packages/relay/README.md`); run the relay under a container or process memory limit sized from that. Before a public pilot, limit who can create rooms and make **End session** invalidate both links. Today any writer key can claim its room, up to the room cap. When the host leaves, other people can still join while the room exists. After expiry a writer can recreate an empty room with the same key. The current relay keeps a readable copy of the script in memory. TLS protects the network connection. The host should see who operates the relay before the script is sent, and the proxy and hosting platform must omit invite keys from access logs.

Test the pilot with two Macs on different internet connections, including a host disconnect, relay restart and revoked invite. Keep the existing private-network option for writers who want the script to stay on their own machines.

### Invites

```
screenplay://join?host=192.168.1.20:52144&room=<room>&key=<key>
screenplay://join?host=192.168.1.20:52144&room=<room>&key=<read-key>&access=read
screenplay://join?relay=wss%3A%2F%2Frelay.example.com&room=<room>&key=<key>
```

| Parameter | Meaning |
| --- | --- |
| `host` | `address:port` of a plain `ws://` relay. |
| `relay` | Full relay URL (`ws://` or `wss://`), used instead of `host` for anything else. |
| `room` | Room name, derived from the read-write key (below): 22 base64url characters. |
| `key` | Read-write key, or the read-only key when `access=read`. Same encoding. |
| `access` | `read` marks a read-only invite. A hint for the client's UI; the relay decides access from the key. |

`parseInvite` and `formatInvite` in `packages/relay/src/protocol.ts` implement this. Room names and keys must match `^[A-Za-z0-9_-]{16,64}$`.

### Keys and read-only access

- The **read-write key** is 128 random bits from a CSPRNG.
- The **read-only key** is derived from it: the first 16 bytes of `SHA-256("screenplay-read-key:" + key)`, base64url. Anyone with the read-write key can make the read-only key; the read-only key reveals nothing about the read-write key.
- The **room name** is derived from the read-write key too: the first 16 bytes of `SHA-256("screenplay-room:" + key)`, base64url (`deriveRoom` in `protocol.ts`, `roomFor` in `relay.ts`). It proves to a relay that whoever presents the key owns the room, and reveals nothing about either key.
- A relay stores only a room's read-only key. A client that presents `k` gets read-write access if `derive(k)` equals the stored read-only key, read-only access if `k` equals it, and is refused otherwise. Comparisons are constant time.
- **Opening a room:** the self-hosted relay creates a room when a client connects to an unknown room name with the read-write key that name is derived from, and stores that key's read-only key. Any other key for an unknown room (a reader who arrives before any writer, after a relay restart or after an empty room expired) is refused with 4425 and creates nothing, so a read-only key can never open a room, take one over or lock writers out. The embedded relay never opens rooms on request; its rooms exist only because the host made them, and they use the same derivation.
- A read-only client receives sync and awareness messages and may publish its own awareness (so writers see "Backlot, read-only"). The relay silently drops every sync step 2 and update message it sends, and any awareness message that names a client ID another connection speaks for.
- Keys travel only in invites and connection URLs. Neither the app nor the relay logs them.

Backlot joins with the read-only invite the host copies from the Co-writing panel.

### Connection

Open a WebSocket to:

```
<relay>/<room>?key=<key>
```

with binary messages. A refused connection is accepted at the WebSocket level, sent an auth message (below) and closed:

| Close code | Meaning | Client should |
| --- | --- | --- |
| 4401 | Wrong or malformed key | Stop; show "refused". |
| 4404 | No such room, the host stopped sharing, or the host's app quit | Stop; the session is over. |
| 4400 | The client sent a malformed message, or more presence than the relay allows | Stop or reconnect once. |
| 4425 | A self-hosted relay has no such room yet, and this key cannot open it (a read-only key) | Reconnect with backoff; the room opens when a writer connects. |
| 4429 | The relay is full: it has no room for another room or connection | Reconnect with backoff; show "the relay is full". |
| 4413 | The change would take the room's script past the relay's size limit. Sent mid-session, without an auth message; the change is not applied | Stop; resending the same state would fail again. Show "the script is too large for this relay". |
| 1009 | A message was larger than the relay accepts (the WebSocket "message too big" code), usually a writer's first sync of a script past the relay's size limit; nothing from it is applied | Stop, as for 4413; resending the same state would fail again. Show "the script is too large for this relay". |
| 1001 | A self-hosted relay is shutting down | Reconnect with backoff; the first writer back rebuilds the room. |
| anything else | Network loss | Reconnect with backoff. |

The desktop client backs off from 0.5 s, doubling to 30 s, with jitter. The relay pings every 30 s and drops connections that miss a pong.

### Messages

The wire protocol is y-websocket's. Every message starts with a varUint message type (lib0 encoding):

| Type | Name | Body |
| --- | --- | --- |
| 0 | sync | A y-protocols sync message: varUint step (0 = step 1, 1 = step 2, 2 = update), then a varUint8Array payload (a state vector for step 1, a Yjs update otherwise). |
| 1 | awareness | varUint8Array: a y-protocols awareness update. |
| 2 | auth | varUint 0 (permission denied), then a varString reason. Sent by the relay only. |
| 3 | query awareness | No body. The receiver replies with an awareness message holding every state it knows. |

Handshake: on connect the relay sends sync step 1 (its state vector) and an awareness message with everyone present. The client sends sync step 1; the relay answers with step 2 (what the client lacks). The client answers the relay's step 1 with its own step 2, which is how the host's script reaches the relay. After that both sides send `update` messages as the document changes. A client is "synced" once it has received step 2.

Apply remote updates with a transaction origin that your undo manager does not track (the desktop app uses the client object), so a writer's undo never removes someone else's typing.

### Presence (awareness state)

Each client publishes one JSON object:

```json
{
  "user": { "name": "Maya Lopez", "color": "#b5442c", "readOnly": true, "app": "screenplay-desktop" },
  "cursor": { "anchor": { "paragraphId": "…", "offset": 12 }, "head": { "paragraphId": "…", "offset": 12 } },
  "doc": { "name": "Pilot" }
}
```

- `user.name` is required; states without it are ignored. The desktop default is the macOS account's full name, overridden by the "collab.name" setting. `color` is `#rrggbb`. `readOnly` and `app` are optional.
- `cursor` is the caret and selection by paragraph ID (the engine's stable IDs) and character offset into the paragraph's text, or `null`.
- `doc.name` is published only by the host; guests use it to title their window.

The relay keeps awareness per room and removes a client's states when its socket closes. Clients renew their state every 15 seconds; states not renewed for 30 seconds expire (y-protocols defaults).

### Joining from the desktop app

"Join Co-writing Session…" takes an invite. If the window holds an untitled, unchanged script, the shared script replaces it; otherwise it opens in a new window. Either way the guest starts from an empty Y.Doc, so the host's document wins and nothing of the guest's mixes in. The window keeps its own script until the host's state has arrived; a refused, closed or unreachable session (15 s) is reported in the Join dialog and changes nothing. If the writer types in the window (or opens another script) while the host's state is on its way, the window keeps that work and the shared script opens in a new window instead. "Stop Sharing" closes the room (guests get 4404 and keep their copy open, unshared); "Leave Session" disconnects one guest.

## Folder sync

For one writer's own Macs through iCloud Drive or Dropbox, without any server. It works only for documents saved as `.screenplay`, because only that format carries the Yjs history every device must share (an FDX or Fountain file reopened on another Mac gets fresh Yjs IDs, and merging logs into it would duplicate the script).

### Layout

```
Pilot.screenplay
Pilot.screenplay-sync/
  <deviceId>.ylog      one per device, appended only by that device
```

The sidecar folder is named after the document without its extension, plus `.screenplay-sync`. A device ID is 128 random bits in base64url, created once per app install (setting `sync.deviceId`). Because each file has one writer, cloud services never see conflicting writes to it. Temporary files start with `.` and must be ignored.

Folder sync is on for a document when the writer turned it on (File > Sync Through Folder; setting `collab.folderSync`, path to on or off) or, when they have made no choice on this Mac, when the sync folder already exists next to the file as a real folder (a link in its place does not count). The `.screenplay` file itself is still saved in full on every Save; it may get the cloud's "conflicted copy" treatment if two Macs save it at once, but either copy plus the logs holds every change.

### Log file format

All integers are big-endian.

```
header:  "SPYLOG01" (8 bytes ASCII) | generation (16 random bytes)
record:  length (u32) | CRC-32 of payload (u32, IEEE, as zlib) | payload (length bytes: one Yjs update, v1 encoding)
```

A file is a header followed by zero or more records.

### Writing (the owning device)

- Append records for local changes. The desktop app batches changes for 250 ms and merges them (`Y.mergeUpdates`) into one record.
- On start, the device appends whatever its document has that its log lacks (`Y.diffUpdate` against the log's merged state vector), so edits made while sync was off still reach the other Macs.
- If its own log ends in a torn record (a crash mid-append), or holds a record that is not a Yjs update, the device rewrites the log before appending, so readers are never stuck behind it.
- **Compaction:** past 1 MB the device rewrites its log as a single merged record under a new random generation, written to a temporary file and renamed into place.
- Temporary files get a random name (`.<deviceId>.ylog.<random>.tmp`) and are created with `O_CREAT | O_EXCL`, so a file or link someone put at a guessable name is never written through.

### Reading (every other device)

- Watch the folder (`fs.watch`) and also rescan every few seconds, since cloud folders deliver changes late and file watchers miss some.
- Keep, per log file, the generation and the offset just past the last record read. Skip files whose size and modification time have not changed.
- Read from the offset. Stop at the first record that is incomplete (fewer bytes than its length) or whose CRC does not match: the file is still arriving. Do not advance past it; read again on the next change.
- A CRC shows only that a record arrived whole. Anyone who can write the folder can write a record with a valid CRC that is not a Yjs update, and merging or applying it throws. Decode each record (`Y.decodeUpdate`) before passing it on. Skip one that fails, advance past it (it will never become valid), and tell the writer once per log.
- Treat each log on its own. A log that cannot be read, or is larger than 64 MiB (`MAX_LOG_BYTES`; a sparse file costs nothing to make), is skipped and reported, and the other logs are still read. Check the size on the open descriptor before reading.
- Apply the records one at a time, so a record that decodes but fails to apply costs only itself. A reader has already moved its offsets past a batch by the time it applies it, so a batch dropped whole is lost for good.
- If the generation changed (the owner compacted) or the file is now shorter than the offset (an older version was synced in), read the file from the start. Re-applying records is harmless.
- Apply records with a transaction origin the undo manager does not track.

The desktop app also appends co-writing changes it receives to its own log, so a Mac that is folder-syncing but not in the live session still gets them.

### Links and special files

The sync folder can sit in a folder other people write to, such as a Dropbox folder shared with a co-writer, and Dropbox syncs symbolic links as links. A link there could otherwise make a Mac append its typing to any file it can write (`~/.zshrc`), or read another script's log and merge it into the shared one. So a client never follows a link anywhere in folder sync:

- **The folder.** Before using it, and before creating it, `lstat` the sync folder: it must be a directory, not a link (a link synced from another Mac often points at a path missing here, so `mkdir` must not see it first). If it is a link or a file, sync stays off for that document with an error, and it never turns on by itself. Remember the folder's real path (`realpath`) and its device and inode at start, and check before every read and write that the folder is still a real directory with that same real path or that same device and inode. (The inode covers a folder above it renamed only in case: macOS then reports a different real path for the same directory. The real path covers a cloud client that deletes and recreates the folder.) If it is not, stop: read and write nothing more in it, and tell the writer.
- **Each log.** Open logs with `O_NOFOLLOW` (and `O_NONBLOCK`, so a FIFO cannot block the open), then `fstat` the open descriptor. Use the file only if it is a regular file with one name (`nlink` 1). Skip anything else (a link, a hard link, a FIFO, a socket, a directory named `*.ylog`) and warn once per name. Where a platform has no `O_NOFOLLOW`, `lstat` first.
- **Your own log.** Append only with `O_WRONLY | O_APPEND | O_NOFOLLOW`, without `O_CREAT`, and only to a regular file with one name. If your log is missing or is anything else, write a new log under a temporary name and rename it into place. The rename replaces the link itself and never writes through it. The new log holds everything the old one held plus the new changes (the desktop app keeps its own records in memory for this), so a device that had not read the old log yet still gets every change. The writer's text stays in the open document throughout.
- Every file folder sync reads or writes is therefore a regular file directly inside the real sync folder.

The desktop app applies the same rule outside folder sync. A script the writer opened is granted by the path and by where that path led at the time. If someone later swaps the script for a link to another file, or swaps a folder above it for a link, the app refuses to read or save through that path until the writer picks the file again. Recent files and remembered windows are stored with where the script really sat (its folder's real path plus its name), and are not re-granted at launch if the script is now a link or no longer sits there, which is what a folder above it swapped for a link looks like. Saves create their temporary file with a random name and `O_EXCL`. Reads refuse anything that is not a regular file, so a FIFO cannot hang the app.

## Backlot client checklist

1. Parse the read-only invite (`parseInvite`), connect to `<relay>/<room>?key=<read-key>`.
2. Use `RelayClient` from `@screenplay/relay/client` with `readOnly: true`, or implement the handshake above.
3. Load the Y.Doc into `ScreenplayDoc` from `@screenplay/engine` and observe it; scene and paragraph IDs are stable across edits.
4. Publish awareness with `user.name` (for example "Backlot") and `user.readOnly: true`, and `cursor: null`.
5. On close code 4404 the host stopped sharing; keep the last state.
6. On close code 4425 (a self-hosted relay restarted, or the room sat empty and expired) keep the last state and reconnect with backoff; the room comes back when a writer connects. `RelayClient` does this, with status "reconnecting" and `reason` "the room is not open yet". Never try to open a room with the read-only key: the relay refuses it by design.
7. Room names in invites are derived from the read-write key. Take the room from the invite as it is; a reader cannot and need not derive it.

## Paired phone remote

The phone is a reader and suggestion inbox client. It never edits the screenplay. Notes
become project notes only when the writer accepts them. Dictation becomes material in
Cuts for review, never an automatic insertion into the script. Typed `draft` suggestions
are parsed as Fountain and previewed in the Phone panel. Only **Accept draft** inserts
the reviewed elements after the attached paragraph; **Ignore draft** drops the item.
The inbox remains owned
by the window that opened the script. A hash of a path alone grants no inbox access.

### Live transports

The Phone panel offers private LAN IPv4 interfaces and the Tailscale interface
(`100.64.0.0/10`). It discovers Tailscale with an allow-listed CLI executable, `status
--json` and `ip -4`, with an interface scan as a fallback. CLI arguments are separate
validated strings; no shell is involved.

Tailscale links always use `https://<mac>.<tailnet>.ts.net:<port>` and WSS. Cold Open calls
`tailscale cert` for the validated MagicDNS name, writes certificate files beneath
userData with private permissions, loads the key only in main, then removes temporary
files. Tailscale manages its own certificate cache. Cold Open requests a certificate when
starting/restoring a listener and refreshes a running listener daily. Neither PEM keys
nor certificate paths enter the renderer or settings. If issuance fails, sharing fails
with instructions to enable MagicDNS and HTTPS Certificates in the Tailscale admin
console's DNS page. There is no HTTP fallback over Tailscale. The phone must have
Tailscale installed and connected to the same tailnet; this does not wake a sleeping Mac.

See [Tailscale HTTPS setup](https://tailscale.com/docs/how-to/set-up-https-certificates)
and the [cert command](https://tailscale.com/docs/reference/tailscale-cli). Enabling
HTTPS publishes the machine's DNS name in certificate transparency logs.

Home Wi-Fi links are plain `http://` and `ws://` carrying a [sealed link](#sealed-link-home-wi-fi):
every body and message is encrypted and authenticated under keys from the pairing
secret, with no certificate, no trust prompt and no HTTP or HTTPS choice. The Mac no
longer accepts a certificate and key for a LAN address, and a LAN listener never
accepts a bearer for the app's requests. Pairing validation accepts private LAN IPv4
(and loopback for local tests) for sealed links, and HTTPS CGNAT addresses and HTTPS
`*.ts.net` hostnames for Tailscale. It rejects public hosts, other DNS names,
credentials, paths and mixed-origin invites. The link and the read-only relay invite
must address the same origin.

### Pairing and lifetime

The QR code is JSON, in one of two versions. Tailscale codes are version 1:

| Field | Value |
| --- | --- |
| `v` | `1`. |
| `url` | HTTPS URL with the bearer token in its fragment. Also the Safari page's link. |
| `invite` | Same-origin `screenplay://join` read-only invite. |
| `expiresAt` | Expiry in Unix milliseconds, at most two hours after creation. |

Home Wi-Fi codes are version 3:

| Field | Value |
| --- | --- |
| `v` | `3`. |
| `host` | The Mac's private IPv4 address and port, `192.168.1.20:4456`. |
| `secret` | 32 random bytes, base64url (43 characters). The root of the sealed link's keys. Never sent. |
| `invite` | Same-origin `screenplay://join` read-only invite (`ws://`). Its key travels only inside the sealed tunnel. |
| `expiresAt` | As above. |

Version 2 had the same fields and an earlier sealed link (XChaCha20-Poly1305); only Mac
beta 13 made those codes, and only iPhone build 4, never given to testers, read them.
An iPhone build that knows only version 1 refuses a version 3 code at the scan, with
its general "Scan the code in the Mac’s Phone panel" message. A build that knows
version 3 answers a higher version with **Update Cold Open on this iPhone**, and a
version 2 code or a version 1 code for a LAN address (an older Mac) with **Update Cold
Open on your Mac, then pair again.** A version 1 LAN pairing or a version 2 pairing
already in the Keychain loads as unusable: it never connects and never sends its token,
the status reads **Pair again to encrypt this link**, and its waiting takes can still
leave by AirDrop or the iCloud folder.

When **Remember this iPhone** is selected, the script must already be saved. The code
adds `remembered: true`, `deviceId` (a UUID), and `scriptId` (the saved script's 64-character
path hash); `expiresAt` is `null`. The phone keeps the code in its device-only Keychain.
The Mac persists device ID, phone-reported name, token SHA-256 hash, script identity,
created/last-seen times, transport, a separate room writer key and, for a home Wi-Fi
pairing, the sealed link's version 3 root key (`root`) in main-only
`userData/phone-devices.json` (mode 0600). The file is outside renderer file grants and
settings. Only the initial QR code contains the raw token or secret; it cannot be
reconstructed from saved state. A device saved by an earlier version with neither a
Tailscale hostname nor a `root` was paired over an unencrypted LAN listener, or by Mac
beta 13, which stored a version 2 root as `link` that no version 3 key can be made from.
The Mac starts no listener for it, lists it as needing to be paired again, and still
imports its signed takes from the iCloud folder or an AirDrop file until the writer revokes it. Status IPC returns device names and times, never hashes
or room writer keys. `POST /api/device { name }` reports the phone's name;
`GET /api/device` returns `{ open: boolean }`.

Remembered listeners share a stable port per interface, default **4456**, configured by
`phone.port` through the Phone panel; the main process validates changes and requires
all remembered devices to be revoked first. Keep it unchanged while devices are remembered; changing it requires new
pairings. Each device has its own stable reader room derived from its saved writer key.
The desktop publishes its Y.Doc to that room through a loopback socket. The external
listener accepts only the read key, even if presented with the writer key. Tailscale
uses WSS with the same certificate; home Wi-Fi uses the sealed tunnel. Other co-writing
sessions are unaffected.

A remembered device always follows the saved path it was paired to. Other windows do
not redirect it. If the same script is open twice, the first window to resume the room
publishes it until that window closes; the remaining window resumes on the sharing
notification. Closing/switching the script closes its device rooms with **4425** so
readers wait and queue. The authenticated device-status endpoint says the paired script
is not open. Once Cold Open and that script reopen after restart/reboot, the same port, bearer
hash and room restore the link without a QR scan. Listener startup retries every 30 seconds
if Tailscale was unavailable. The phone creates a fresh read-only Y.Doc on reconnect,
retaining its cached reader while offline, so reopening FDX/Fountain with fresh history
cannot merge an old reader copy into the new script.

**Save As** keeps remembered devices attached to the original path and its inbox.
Pair again for the new copy. Renaming or moving the file also requires a new pairing.
Untitled scripts support one-off links only. The first save of an untitled script keeps
its one-off link, because the inbox and link move to the new path key together. Stopping
sharing ends only this window's one-off link. Remembered devices stay paired and
connected. Window/document changes only detach remembered links. **Revoke** beside a device permanently disables
its credential, stops its room with **4401**, and refuses future folder imports. The phone
shows **This Mac revoked the pairing** and persists that terminal state across launches.
On home Wi-Fi the Mac keeps answering a revoked iPhone with a sealed 403, so the iPhone
ends the pairing only on the Mac's own word.
One-off links still expire after two hours or end on Stop/document change/window close.

### Sealed link (home Wi-Fi)

The reference code is `packages/relay/src/sealed.ts` (MIT), run unchanged by the Mac and
the iPhone. It imports no crypto library: each end supplies the primitives, HKDF-SHA256
(RFC 5869, extract and expand in one call), AES-256-GCM (32-byte key, 12-byte nonce,
16-byte tag, output ciphertext followed by the tag) and random bytes from the operating
system. The Mac uses the app's built-in crypto, `node:crypto` in Electron
(`packages/relay/src/sealed-node.ts`); the iPhone uses Apple's CryptoKit
(`apps/mobile/modules/link-crypto`).

**Keys.** `secret` is the 32 bytes in the pairing code. `hkdf(ikm, salt, info, length)`.

```
root     = hkdf(secret, "coldopen-phone-link-v3", "root", 32)
kid      = hkdf(root, "", "kid", 16)                    public pairing ID, base64url (22 characters)
k_up     = hkdf(root, "", "http phone to mac", 32)
k_down   = hkdf(root, "", "http mac to phone", 32)
```

The Mac stores `root` for a remembered iPhone and derives the rest. `kid` names the
pairing on the wire and reveals nothing about the keys.

**HTTP.** Every API call is `POST /link` with a `text/plain` body:

```
base64url( 0x03 | kid (16) | rid (24) | AES-256-GCM(key, 12 zero bytes, aad, plaintext) )
key       = hkdf(k_up, rid, "request", 32)
aad       = "coldopen-link-v3 request" | kid
plaintext = UTF-8 JSON { "t": <Unix ms, Mac clock>, "e": <run ID>, "m": "GET" | "POST", "p": "/api/inbox", "b": <JSON body> }
```

`rid` is 24 random bytes that name the request. Each request has its own key, which seals
that one message, so the nonce is fixed at zero. GCM must never see one nonce twice
under one key, and this schedule guarantees it: every HTTP key seals one message, and
every WebSocket key belongs to one direction of one connection, whose counter only goes up. The inner `p`, `m` and `b` are the
request the API sections below describe; the 24,000-byte limit applies to `b`. The
answer is HTTP 200 with a `text/plain` body:

```
base64url( sid (24) | AES-256-GCM(key', 12 zero bytes, aad', plaintext') )
key'       = hkdf(k_down, rid | sid, "response", 32)    rid is the request's
aad'       = "coldopen-link-v3 response" | rid
plaintext' = UTF-8 JSON { "s": <status>, "b": <JSON body>, "now": <Unix ms, Mac clock>, "e": <run ID, with 425> }
```

`sid` is 24 random bytes. `s` is the status the call would have had over HTTPS, and the
phone acts on that alone. Binding the answer to the request's `rid` means a recorded
answer never fits a later request. A request that names no pairing, fails
authentication or repeats a `rid` gets a bare `403 {"error":"Pairing refused."}` in the
clear. The phone treats any answer that is not sealed as "not reached": it retries and
never ends a pairing on it.

**Replay.** The Mac runs a request once. Each time the Mac starts serving a pairing it
makes a random 16-byte run ID (`e`, base64url). A request is run only if it names the
current run ID, carries a `rid` not yet seen in this run, and has a `t` within 120
seconds of the Mac's clock. Anything else that authenticates gets a sealed `425` whose
`e` and `now` let the phone retry once with the right values; it is never run. So the
phone's first request to a Mac, and its first after the Mac restarts, costs one extra
round trip, and phones need no accurate clock. A request recorded in an earlier run
names the wrong run ID and is never run again, whatever its timestamp: the Mac forgets
seen request IDs when it restarts, and the run ID changes with them. The time window
only bounds how long a `rid` is remembered.

**WebSocket.** The phone opens `ws://<host>/sealed/<kid>`. The room and its key are
not in the URL.

```
Mac   → phone   0x03 | serverRandom (32)                       in the clear
phone → Mac     0x03 | clientRandom (32)                       in the clear
k_c = hkdf(root, clientRandom | serverRandom, "ws phone to mac", 32)
k_s = hkdf(root, clientRandom | serverRandom, "ws mac to phone", 32)
every later message = AES-256-GCM(key, nonce = 4 zero bytes | counter (u64 BE), aad = empty, type (1) | payload)
```

Each direction counts its messages from 0 and the counter is not sent, so a message
that is replayed, dropped, reordered or taken from another connection fails to open and
the connection ends. Plaintext types: `0` a relay message (the y-websocket bytes
above), `1` the phone's first message, JSON `{ "room", "key" }` with the read-only key,
`2` the Mac's close notice, JSON `{ "code", "reason" }`, sent just before it closes.
The phone believes a close code only from a sealed notice; any other close is a lost
connection and it reconnects. A home Wi-Fi listener refuses every WebSocket that is not
sealed.

**The Safari page.** A page loaded over plain HTTP cannot keep a key from someone who
can alter the page, so it does not use the sealed link. Over Tailscale it is served
over HTTPS with the version 1 bearer. On home Wi-Fi it exists only when the writer
ticks **Also make a Safari link (not encrypted)** for a one-off pairing. It then has its
own random bearer, separate from `secret`, which may read `/api/snapshot`, post
`/api/command` and post passage-anchored `/api/inbox` items, and nothing else. `secret`
is never accepted as a bearer.

### Suggestions, receipts and retries

`POST /api/inbox` accepts a captured table-read cue/revision (browser), or
`{ id, kind, text, paragraphId, sourceText }` (app). The latter permits `note`, `dictation` and
`draft`. IDs match `^[-\w]{12,80}$`; paragraph IDs are nonempty and at most 160
characters; source text is at most 1,500 characters. Text is nonempty and at most 20,000
characters. The complete UTF-8 JSON request must fit **24,000 bytes**. The phone measures
the serialized request, including anchors and escaped characters, before queueing it.
The anchor and quote stay together if a paragraph disappears. The phone proposes the
nearest surviving paragraph, or the visible paragraph, and asks for confirmation before
composing against a replacement.

Retries reuse the exact receipt ID, text, kind and anchor. A 200 reply with that ID means
the Mac saved it, not that the writer accepted it. Permanent HTTP failures (400, 413,
422, or a 409 for conflicting receipt content) become terminal **Rejected** entries with
a reason and selectable text. Transient capacity/storage/network failures keep queueing.
Rejected items cannot occupy the oldest-eight retry batch indefinitely.

Authenticated `GET /api/receipts` maps reviewed IDs to
`{ "outcome": "accepted" | "ignored", "contentHash": "<sha256-hex>" }`. The content hash
is SHA-256 over the UTF-8 encoding of `JSON.stringify([kind, text, paragraphId, sourceText])`.
The phone applies a decision only when this hash matches its queued take. A missing or
mismatched hash leaves the take pending with a **Receipt conflict** message in Status;
automatic delivery waits so a conflicting receipt cannot turn the real take into a
terminal rejection. Missing IDs imply nothing. Remembered-device receipts and content
signatures survive restarts, review, and delivery through either transport. The Mac records the decision before
removing the pending inbox item. Re-delivery after review cannot recreate it. One-off
receipts retain their session lifetime; durable inbox items survive Stop. A new pairing
never silently retargets old pending text.

Draft text uses the engine's `parseFountain`, not the speech formatter. It is parsed as
a passage (no title page); if there are no paragraphs, the original text becomes action.
Acceptance requires the attached paragraph to survive with its captured source prefix.
A changed or missing attachment leaves the draft pending for review. Insertion and its
project-cut receipt share one undoable document transaction. Repeated acceptance after
a lost acknowledgement does not insert twice, including after native document reopen.

On iPhone, Write and its microphone share one multiline field and cursor. Backgrounding
keeps the mounted editor and its text; speech finishes when the app backgrounds. Send
writes a `draft` take synchronously to the existing SQLite outbox before trying the Mac.
Queued drafts survive app termination. Cancel discards unsent editor text. Drafts use
the same remembered pairing, size limits, receipts, retries and folder envelope as notes.

### iCloud Drive fallback

On iPhone, **Status → Choose iCloud Drive fallback folder** opens a native Files folder
picker (`UIDocumentPickerViewController`, folder mode, open in place). The local Swift
module saves a security-scoped bookmark, renews stale bookmarks, and accesses the scope
only for coordinated writes. This needs no app iCloud container entitlement or paid
Apple developer account. On the Mac, choose the same folder in the Phone panel's native
folder dialog. That grant, including real path/device/inode, stays in main-only state.
Folder contents are untrusted. Every item must authenticate to its remembered iPhone;
write access to the folder does not authorize suggestions. The folder contains neither
the pairing bearer nor its signing key. Text remains readable to folder participants.

When live delivery fails, the active phone app writes pending remembered-device items:

```text
<picked folder>/
  Inklot Phone Inbox/
    <deviceId>/
      <receiptId>.json
```

Each file is UTF-8 JSON, at most **26,000 bytes** including the envelope:

```json
{
  "v": 1,
  "deviceId": "<paired-device-UUID>",
  "scriptId": "<64-character-saved-path-hash>",
  "id": "<receipt-ID>",
  "kind": "note",
  "text": "Check this prop.",
  "paragraphId": "<captured-paragraph-ID>",
  "sourceText": "The captured passage.",
  "sig": "<base64url-HMAC-SHA256>"
}
```

`sig` is an unpadded base64url HMAC-SHA256 over the UTF-8 encoding of:

```js
JSON.stringify(["inklot-take-v1", deviceId, scriptId, id, kind, text, paragraphId, sourceText])
```

The key is the 32 raw bytes of SHA-256 of the pairing token (the version 3 `secret`,
as its 43-character text). The Mac already stores
that digest as `tokenHash` in private remembered-device state; the phone derives it
from its Keychain token. The hex spelling is decoded to bytes on the Mac, never used
as the key text. Neither device writes the key into a take file. The phone implements
RFC 2104 HMAC with Expo SHA-256 byte digests, a 64-byte block and the standard pads.
The Mac uses `crypto.createHmac` and `timingSafeEqual`, with strict base64url validation.

The inbox body fields must also fit the live 24,000-byte request cap. No audio or
screenplay update is written. Native writes use a random dot-prefixed temporary file
with `O_EXCL | O_NOFOLLOW`, flush it, then rename it to the receipt filename. The outbox
shows **Saved to iCloud** after the coordinated file write succeeds. This means saved to
the selected Files provider, not proof that iCloud has uploaded it or the Mac imported
it. Choose an actual iCloud Drive folder for cloud delivery. A failed folder write stays
pending with its error. Work continues when the app is active or returns to foreground;
there is no background-delivery entitlement or guarantee.

Main watches the root/inbox and recursively watches device folders, with a five-second
rescan for delayed iCloud arrival or unavailable notifications. It processes only
remembered, unrevoked device directories, checks the script identity against that
device's saved binding, validates the filename/ID/shape/size and signature, then imports
into that script's durable inbox even if the script is currently closed. Only an owning window
can later read or review it. Unknown device directories are ignored. Invalid files and
mismatched script identities remain untouched and warn once per filename. Missing, malformed or incorrect signatures
are refused before inbox or receipt writes. Unsigned files from older app builds must
be sent again from an updated phone. Successfully persisted files are unlinked;
temporary files are ignored. Live retries and cloud imports share the durable receipt ledger.

The link/special-file rules above apply to every level: validate real directories before
creation/use, remember real path/device/inode, and recheck before reads/import/removal.
Read only `O_NOFOLLOW | O_NONBLOCK` descriptors whose `fstat` reports a regular,
single-link file. Never read symbolic/hard links, directories, sockets or FIFOs. Replacing
a granted folder or an ancestor with a redirected path stops imports until it is chosen
again. Cloud recreation at the same real path is allowed.

Decisions return through **live `/api/receipts` only**. There are no `.decision.json`
files. A saved item remains Saved to iCloud until live delivery/status resumes, then can
show Delivered, Accepted or Ignored. This keeps all decisions authenticated and avoids
trusting a decision file another folder participant could forge.

### AirDrop takes file

When the iPhone and the Mac share no network at all, **Status → Send to Mac** writes the
waiting takes to `Cold Open takes <YYYY-MM-DD>.coldopentakes` in the app's cache and opens the
iOS share sheet. The writer AirDrops the file to the Mac. The file is UTF-8 JSON:

```json
{
  "v": 1,
  "deviceId": "<paired-device-UUID>",
  "scriptId": "<64-character-saved-path-hash>",
  "takes": [
    {
      "id": "<receipt-ID>",
      "kind": "note",
      "text": "Check this prop.",
      "paragraphId": "<captured-paragraph-ID>",
      "sourceText": "The captured passage.",
      "sig": "<base64url-HMAC-SHA256>"
    }
  ]
}
```

Each take keeps the iCloud field set and the 26,000-byte limit. One file carries at
most 100 takes and at most 2.6 MB. After a successful share the outbox shows **Sent by
AirDrop**; those takes remain pending and retry live exactly like iCloud items, and there
are still no decision files.

Opening the file on the Mac treats it as an imported folder file: the same validator
checks version, receipt ID format, take shape, size and signature; the device must be
remembered and unrevoked; the script identity must match that device's binding; and a window must have
that script open. The Main process imports each take through the folder store and receipt
ledger, so a take that also arrived live or through iCloud appears once. Cold Open refuses a
file for a closed script or an unknown iPhone with a message and changes nothing.
Every take uses the same signing key and canonical message as an iCloud item, with
`deviceId` and `scriptId` taken from the outer envelope. All signatures are checked
before importing any take or touching receipts. One missing, malformed or incorrect
signature refuses the whole file with an authentication error. Revoked devices have
no usable verification key.


## Production changes in reviewed Backlot handoffs

Cold Open's **Production changes** panel compares the working script with the last
successfully applied reviewed handoff. The existing FDX preview/apply flow remains the
acceptance boundary. Backlot must enforce its own review rules for scheduled or issued
work. This addition does not implement automatic breakdown updates in Backlot.

The document's Yjs `meta` map stores immutable `backlot.handoffBaseline.<uuid>` records:
`{ version: 1, projectId, revision, sentAt, scenes: ProductionScene[] }`. Each project uses
its highest accepted Backlot revision, so concurrent handoffs converge regardless of
Yjs client identity or clock skew. Acceptance deletes superseded records for that project.
The snapshot comes from the captured FDX preview. Cancellation and failure never advance
it. Accepted handoffs bypass script Undo; edits made after capture remain pending.
Native `.screenplay` saves and co-writing preserve the records. A project's first handoff
reports every scene as added.

FDX and Fountain use private main-process sidecars keyed only by the script's saved path.
A Finder rename starts fresh with every scene shown as new until the next handoff; in-app Save As carries the baseline to the new path.
Surviving paragraph IDs restore scene IDs after external FDX edits. Positional identity
restoration requires matching file bytes. Each sidecar has an 8 MB limit; writes prune
only entries whose script paths no longer exist, retaining every entry for an existing path.

Both preview and apply requests to Backlot's existing `POST /breakdown/import` include
an additive `productionChanges` field beside `fdxPath`, `mode`, import options and the
existing plan token. The exact captured list is reused at apply. Existing FDX attributes,
including `InklotTagId`, are unchanged. The JSON shape is:

```ts
interface ProductionScene {
  sceneId: string;             // Cold Open stable scene identity
  headingId: string;           // Paragraph identity used by the FDX import
  number?: string;             // Display label, never an identity
  heading: string;             // Full heading, including location/time
  omitted: boolean;
  characters: string[];        // Normalized speaking character names, sorted
  tags: { id: string; category: string; label: string }[];
  eighths: number;             // Integer, using shared print pagination
}
interface ProductionChanges {
  version: 1;
  baselineSentAt: string | null; // null for the first handoff to this project
  scenes: {
    sceneId: string;
    kinds: ("added" | "omitted" | "restored" | "moved" | "heading" |
            "characters" | "tags" | "length")[];
    before: ProductionScene | null;
    after: ProductionScene | null;
    previousPosition: number | null; // 1-based script order
    position: number | null;
    eighthsDelta: number;       // after minus before; missing scenes count as zero
    review: {
      scheduled: boolean;
      issuedCallSheet: boolean;
      needsBacklotReview: boolean;
    };
  }[];
}
```

Rows follow current script order, followed by deleted scenes in baseline order.
`omitted` includes retained OMITTED headings and deleted scenes (`after: null`).
Deleted rows cannot jump to a missing scene. `restored` reverses a retained omission.
A move means relative order among surviving scenes changed; adding/removing a neighbour
alone does not mark a scene moved. Reordering can mark multiple surviving scenes.
Before/after values provide character/tag additions and removals without parsing UI text.
Tags compare resolved identities/category/label once per scene, independent of run
splitting and display tag numbers. Unresolved references use `number:<TagNumber>` IDs.

Main reads only a project chosen in a native dialog (the handoff project, or the existing
read-only Backlot project grant). It maps scenes through `scriptKey.paragraphId`, with
exact scene ID as a fallback, never by heading or scene number. Scheduled strips set
`scheduled`; strips on a day break with a call sheet containing issues set
`issuedCallSheet`. Either sets `needsBacklotReview`. These are advisory flags captured
at preview; Backlot's project-revision check remains authoritative at apply. The panel
refreshes the readable project every five seconds and reports unavailable state rather
than claiming it is unscheduled. A different project cannot supply flags for an existing
baseline. Backlot currently records issue/day references rather than historical issue
scene snapshots, so scenes removed from an issued day's board cannot be recovered from
that data alone.
