# Cold Open Remote

Open **Tools → Phone Companion** on the Mac. For use away from home, choose
**Tailscale · works away from home**, save the script, select **Remember this iPhone**,
and start pairing. Install Tailscale on the iPhone and sign into the same tailnet.
In Cold Open Remote, scan the QR code, or use **Copy app pairing code** on the Mac and
**Paste a pairing code** on the phone.

Tailscale uses HTTPS/WSS with this Mac's MagicDNS certificate. Cold Open obtains it through
the Tailscale CLI; no certificate files need to be picked manually. If issuance fails,
open the Tailscale admin console's **DNS** page, enable **MagicDNS**, then enable
**HTTPS Certificates** and retry. Enabling HTTPS publishes the machine's DNS name in
certificate transparency logs. No HTTP fallback is used over Tailscale.

**Use from anywhere** in the Phone panel runs six checks: Tailscale installed, signed in
and running, MagicDNS on, HTTPS certificates on, an iPhone remembered, and the optional
iCloud Drive folder. Each unfinished step shows one plain action, with a download or
admin-console link where one helps. **Check again** runs the checks again. The checklist
shows no addresses, ports or file paths. The iPhone's pairing screen repeats what the
writer does on the phone under **Away from home?**.

Private LAN addresses remain available. LAN HTTPS needs a trusted certificate covering
the selected IP address. Unencrypted HTTP requires the explicit trusted-Wi-Fi choice.
One-off pairings last two hours. Remembered pairings last until revoked in the Mac's
Phone panel. The panel lists the name reported by each iPhone and its last-seen time.
Revocation closes the connection immediately; the phone remembers **This Mac revoked
the pairing** across restarts.

Remembered links use port **4456** by default (`phone.port` on the Mac). Keep the port
unchanged while an iPhone is paired. After a Mac restart, open Cold Open and the script at
the same saved path. The link resumes without scanning again. With several windows,
the phone follows the script it was paired with. If that script is closed, it says so
and keeps queueing. Save As does not move the pairing to the new copy; pair again for
that copy. A phone cannot wake a sleeping Mac.

Choose **iCloud Drive fallback folder** in the phone's Status screen and select the same
folder in the Mac's Phone panel. The native Files folder picker grants access through a
security-scoped bookmark, without an app iCloud entitlement or paid Apple account. Use
an iCloud Drive folder for cloud delivery. Offline items are saved as:

```text
<picked folder>/Inklot Phone Inbox/<device id>/<receipt id>.json
```

When live delivery fails, active-app pending items are written atomically there and
shown as **Saved to iCloud**. That label confirms a local Files-provider write; iCloud
may upload later. The Mac watches and rescans every five seconds, checks remembered
device/script identities and each take's HMAC-SHA256 signature, and imports each receipt
once. Folder access alone cannot authorize a take. Signing uses the raw SHA-256 digest
of the pairing token; the key stays on the paired devices. A duplicate arriving live is
harmless, even after the Mac has reviewed it. Accepted/Ignored return through the live
link when reachable, with a content hash that must match the queued take. A mismatched
or missing hash keeps the take pending and shows **Receipt conflict** in Status. There
are no decision files. The phone caches the reader for selecting passages offline. The
app retries on return to foreground, with no guaranteed background delivery.

When there is no network at all, **Send to Mac** on the Status screen writes the waiting
takes to a `Cold Open takes <date>.coldopentakes` file and opens the iOS share sheet, so the
writer can AirDrop it. Takes show **Sent by AirDrop** and stay pending. Open the file on
the Mac (Cold Open opens `.coldopentakes` files, and older `.inklottakes` files) with that script open; the Mac adds each take
to the same review inbox, once, even if it also arrived live or through iCloud. The file
contains a signature on every take. The Mac refuses the whole file if any signature
is missing or invalid, or the iPhone is unknown or revoked. Old unsigned exports must
be sent again from an updated phone. See the
[AirDrop takes file format](../../docs/sync-protocol.md#airdrop-takes-file).

Use the list button to jump to a scene or search paragraph text. **Follow the writer**
tracks the host caret. Select a paragraph, choose **Dictate**, hold to record, release to
finish, and review the transcript before tapping **Send**. Long-press a paragraph for a
note. The tray shows delivery and desktop review decisions. If the selected paragraph was
deleted, the phone proposes a nearby surviving passage and asks before attaching to it.
The complete serialized request, including its anchor, must fit 24,000 UTF-8 bytes.
Oversize text must be shortened or split. Permanently rejected items show their reason
and remain selectable for copying; they do not block later items.

Choose **Write** to type a Fountain passage in Courier Prime. The keyboard toolbar inserts
Scene, Character, Parenthetical and Transition cues. Its microphone dictates at the
cursor in the same field; tap it again to finish. Separate scenes and speeches with
blank lines, and put dialogue directly below the character name or parenthetical.
The attached passage stays visible for context. Backgrounding the app keeps the open
Write screen's text; Cancel discards it. After Send, the complete draft and receipt ID
are saved synchronously in the same SQLite outbox as other takes before delivery, so
queued drafts survive termination and use the same retries and iCloud fallback.

The Mac parses drafts with the engine's Fountain parser and previews their elements
in the Phone panel. **Accept draft** inserts after the attached paragraph through the
reviewed insertion path; **Ignore draft** removes the suggestion. If the attachment
changed or disappeared, acceptance stops and the draft stays in the inbox. A retained
project cut carries the acceptance receipt so a failed acknowledgement cannot insert
it twice. Drafts do not use the speech formatter. Text without parsed elements falls
back to action.

The Mac formats incoming transcripts in the Phone panel with its configured dictation
formatter. The writer can review and save the proposed elements to Cuts, or ignore the
item. If the formatter is unavailable, the original transcript stays in the inbox.
Accepting a cut does not insert it into the screenplay.

## Run on iOS

From the repository root, with Node, Xcode, an installed iOS Simulator runtime, and
CocoaPods available:

```sh
npm ci
npm run ios -w @screenplay/mobile
```

This is a native Expo build. The local Swift speech module is not included in Expo Go.
Expo prebuild generates the Xcode project from `app.json` and the local module in
`modules/local-speech` and `modules/phone-folder`. The app icon and splash PNG are rendered from the desktop
`apps/desktop/build/brand/mark.svg`. No Apple signing identity is committed.

For simulator-only pairing, run the included loopback host with a fresh private path:

```sh
pair_dir=$(mktemp -d)
node apps/mobile/scripts/simulator-host.ts "$pair_dir/code"
```

In another terminal, pass that file to `xcrun simctl pbcopy booted`, then paste it in the
app. The host serves only synthetic text and removes the code file on Ctrl-C.

## Data and tests

- `src/live.ts` projects the shared engine document and host awareness into reader data.
  A future Backlot production feed can subscribe separately at the screen controller in
  `src/useRemote.ts`; revision notices do not belong in the writer's suggestion outbox.
- The pairing lives in the device-only Keychain. SQLite saves text and its receipt ID
  before the app attempts delivery. Unsent items retry while the app is active and on
  return to the foreground. Audio is neither uploaded nor saved as a recording.
- `npm test -w @screenplay/mobile` covers malformed and expired QR codes, awareness,
  wrong receipts, retry isolation, Tailscale validation, permanent failures, native atomic
  folder writes, AirDrop export contents, HMAC interoperability with Node (including
  Unicode), receipt-content conflicts, unreachable wording, and a real relay, phone
  server and disk inbox. The
  desktop Playwright test also drives pairing, typing, review and Stop through Electron.
  The native writer test compiles its actual Swift file on macOS. The iOS Files picker
  and bookmark scope need a native device/simulator check. Its formatter result is a test fixture; the live transport and receipts are real.

[Simulator gallery](../../docs/phone-remote/README.md) · [Wire contract](../../docs/sync-protocol.md#paired-phone-remote)
