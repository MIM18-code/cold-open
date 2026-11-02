# Local voice engines and packs

The existing `status`, `prepare(engine, true)`, `synthesize`, `cancel` and `clear-cache` contracts remain. New engines are `kokoro`, `qwen` and `qwen-design`; `system`, `phonon` and `ming` keep their IDs. Voice selection and model installation are local device settings. These services never write script or shared cast data.

## Installation

`apps/desktop/src/main/models/voice-packs.ts` is the build-owned weight manifest. Each source has a Hugging Face repository and immutable commit. Every downloaded file has an exact size, SHA-256 and local relative path. Requirements, quantization, weight license and conversion provenance are separate pack fields. Source README/license/notice files are retained under `notices/` when present.

The six packs are pinned, with resolved revisions, file sizes and SHA-256 hashes: Phonon 31m English, Kokoro English, Ming 0.5B, Qwen Base 0.6B, Qwen Base 1.7B and Qwen VoiceDesign 1.7B. The committed manifest is the authority for download sizes and upstream license/notice files. Update and review pins with:

```sh
npm run voices:manifest
```

The generator resolves each repository once, lists files at the resulting commit with pagination, uses LFS SHA-256 values, and hashes downloaded non-LFS files. It preserves a previously resolved commit on subsequent runs. To review a newer revision, explicitly change the selected source revision first. Ming's speech weights no longer follow `main` at inference time; the separately pinned CAMPPlus dependency is included. Review the resulting file filters, model cards, sizes and licenses before distribution. The generator refuses empty matches and writes the manifest only after all packs succeed.

Open **Table read > Manage voice packs…**, or **Tools > Local Features and Model Readiness…**. Both use the same Local features settings screen. Each pack shows its purpose, transfer size, minimum memory, macOS requirement, license/notice links, installed verification state and disk use. Click Install (or Resume install / Retry), review the size, license and provenance, then Confirm download. A Mac below the declared memory minimum shows a warning and requires a separate Install anyway checkbox. Loading an installed pack on a low-memory Mac also asks for explicit consent; consent lasts for that window's runtime.

Downloads show byte progress and Cancel download. Cancelling or closing setup retains partial files. Retry resumes retained bytes and verified files; checksum failures never become installed packs. Remove deletes the selected pack, including incomplete files, to free space. Refresh voice packs rechecks installed state. No test downloads production weights.

The table read refreshes its engine and voice inventory after setup changes without restarting. Select an installed engine and click Load voice engine. Uninstalled engines link to the same setup screen rather than starting an unconfirmed download. Mac voices remain available without a neural pack. Qwen uses the preferred installed Base variant for this Mac (0.6B below 32 GB, 1.7B at 32 GB or above), falling back to the other variant when only it is installed.

`sizeBytes` is the exact transfer payload, not allocated filesystem blocks; `diskBytes` includes partial downloads and derived files. An unresolved manifest entry is unavailable and never shown as a zero-byte download.

The installer keeps `.part` files across interruption. It requests `Range`, checks `Content-Range`, restarts when a server ignores ranges, bounds incoming bytes and checks SHA-256 before renaming. It verifies local files before loading and refuses symlink directories. Checksum results are reused only while device file identity, size, modification time and change time match. A new app process rechecks hashes. Removal releases loaded workers first and deletes only the selected app-owned pack. The service serializes mutations for each pack.

## Engine and reference policy

| Engine | Assets and requirements |
| --- | --- |
| Mac voices | Enumerated with `/usr/bin/say -v ?`; no neural download. |
| Kokoro | FluidAudio KokoroAne legacy English ANE pipeline, shared BART G2P, US/GB Misaki lexicons and installed English voice assets. macOS 15+, Apple silicon, 8 GB. Verified JSON voices are converted locally to FluidAudio's float32 pack layout before loading. Seven voices (`af_jessica`, `af_river`, `af_sarah`, `am_eric`, `am_onyx`, `bf_alice`, `bf_emma`) are not offered: in an ASR round trip on ten one- and two-word lines they came back with word error rate 0.6 or higher ("No." heard as "To know."). Padding, leading punctuation and slower speech did not help. The remaining Kokoro voices still garble some very short lines, so prefer Phonon or Qwen for interjections. |
| Phonon | FluidAudio Phonon English 31m pack. macOS 15+, Apple silicon, 8 GB. 40m packs are excluded because their terms differ. The helper enumerates the pack's actual voices. |
| Ming | MLX 0.5B bf16 plus CAMPPlus. macOS 15+, Apple silicon, 16 GB (measured peak 4.3 GB). The three documented English presets retain their IDs. |
| Qwen Base | 0.6B 8bit below 32 GB; 1.7B bf16 at 32 GB or more. Declared minimum 16 GB and 24 GB. Measured peak footprint of the helper was 9.1 GB (0.6B) and 11 GB (1.7B) on a 1190-character line, after a 256 MB MLX buffer-cache cap and a cache clear after each line (before: 19.8 and 20.9 GB). Reads through verified saved references. |
| Qwen VoiceDesign | Optional 1.7B bf16 pack, 24 GB (same weights size as Base 1.7B; its peak was not measured separately). Creates reference assets, not a per-line playback engine. |

Requirements are application support policy, not measured hardware benchmarks. Real quality, memory peaks and latency still require hardware evaluation. These paths use the exact locally inspected Swift dependency APIs pinned in `Package.swift`.

`table-read:voice-catalogue` returns installed IDs with engine, language and descriptive `tags`. Known curated voices have presentation, age, accent and timbre guidance. Unreviewed installed voices explicitly say that age/presentation/timbre are unreviewed; casting must not invent those facts. Enumerating installed packs does not load every model. No total voice count is promised. Catalogue removal never changes a saved cast binding.

`qwen` uses a device-local reference bank. Each immutable voice ID stores `audio.wav` and `reference.json`, with exact transcript, description, tags, provenance, original audio checksum, model checksum and generator version. The cache hashes the entire reference metadata plus its audio checksum. Original reference audio is retained; runtime embeddings are disposable. Re-designing creates a new ID. Never replace a locked binding automatically.

Each character row offers **Design a voice…** when `qwen-design` is installed, or **Install VoiceDesign…** linking to Local features. Enter an original description, then Generate audition. The preview includes a local WAV player; Regenerate replaces the pending audition. Discard (or closing the dialog) cancels generation and drops the pending reference. Nothing enters the reference bank until Keep voice. Keep saves an immutable reference, explicitly assigns and locks that character's Qwen binding, and selects Qwen Base. Other characters and existing bindings remain unchanged. A Base pack must also be installed and loaded for script playback.

The audition uses a fixed, exact transcript rather than screenplay dialogue. The reference retains the description, transcript, model checksum, generator version and audio checksum through `ReferenceBank`. New designs receive new IDs. References default to private provenance. The writer may explicitly allow the generated reference in exported bundles; the existing provenance checks still decide what can travel. Changing description or sharing choice requires a new audition before keeping it. Real-person recording/cloning is not part of this flow.

The `table-read:design-voice` preview request uses `{ action: "preview", label, description, transcript, tags, provenance }` and returns an ID and WAV bytes. `{ action: "keep", id }` saves only the current audition and returns a Qwen voice; `{ action: "discard" }` drops it. Legacy requests without an action still generate and save directly for the starter-bank tool. No cloud service is involved. Base and Ming do not accept arbitrary per-line acting instructions. Unsupported direction/settings fail clearly rather than being spoken or ignored. Pronunciation metadata describes replacements already applied by the caller to `text`; it is never inserted into the screenplay.

The starter definition has sixteen varied adult English recipes, an exact common transcript, and no imitation of a named person. Render it on real hardware after installing VoiceDesign:

```sh
npm run voices:starter-bank -- --data-dir '/path/to/Cold Open userData' --helper '/path/to/voice-helper'
```

This command never installs packs. It skips matching existing recipes and saves every result through the same reference bank. Audition references and review generated-asset rights before redistributing them. The committed recipes are not a claim that an auditioned bank already ships.

## IPC for the player and settings

All requests use the existing trusted-frame bridge. Renderer requests cannot choose an executable, model directory, reference path or download URL.

| Channel | Input and result |
| --- | --- |
| `table-read:prepare` | `(engine, true, allowLowMemory = false, installedOnly = false)`; the UI always sets `installedOnly` so loading cannot start an unconfirmed repair download. |
| `table-read:models` | No input; returns pack states with installed state, size, disk use, revisions, requirements, license and provenance. No absolute paths. |
| `table-read:install` | `(packId, true, allowLowMemory = false)` after showing requirements and obtaining consent; returns updated states. |
| `table-read:model-progress` | Event `{ packId, completedBytes, totalBytes }`, owned by the requesting window. Also emitted by legacy `prepare`. |
| `table-read:remove` | `(packId)`; refuses while a speech job or pack mutation is running. Releases model workers. |
| `table-read:voice-catalogue` | No input; tagged installed voices, including validated reference voices. |
| `table-read:activity` | `{ typing: boolean, dictating: boolean }`; no document mutation. |
| `table-read:design-voice` | Preview/keep/discard actions as above; previews stay in memory until accepted. Legacy generation returns a saved reference voice. |
| `table-read:read-sidecar` | `(scriptPath)` for a granted `.fdx`/`.fountain`; returns the sidecar JSON beside it or null. A link is refused. |
| `table-read:write-sidecar` | `(scriptPath, text)`; writes `<script>.coldopen-read.json` through a random temporary name and rename. At most 4 MB. `table-read:read-sidecar` falls back to `<script>.inklot-read.json` when no current file exists. |
| `table-read:shareable-references` | Up to 32 reference voice IDs; returns only those whose provenance permits sharing, with base64 WAV and no paths. |
| `table-read:import-references` | Validated bundle reference entries; saves shareable voices without replacing an accepted identity and returns old-to-local ID mappings. |

Send `typing: true` on typing activity; it expires after 1.5 seconds without another hint. Send `dictating: true` for the dictation lifetime, then clear it when recording ends or the document changes. The hint must always include both booleans. Tag speculative synthesis with `priority: "prefetch"`; foreground is the default. Prefetch requests fail with a recoverable `Prefetch paused while writing or dictating` message while activity is present. Drop that speculative result and retry after the hint clears. A queued prefetch also checks activity before starting. Already-running synthesis is allowed to finish so foreground work is not killed by a keystroke.

Optional synthesis fields are `direction`, `pronunciations`, `generationSettings` (`temperature`, `seed`, `speed`) and `contextFingerprint`. Supply only pronunciation rules applicable to this speech and relevant neighboring context. Kokoro supports generation speed; Phonon/Ming/Qwen support temperature and seed. Mac generation controls are rejected. Playback speed remains a player control. The audio key includes engine, helper/library version, model-manifest checksum, quantization, voice/reference checksum, NFC-normalized spoken text, direction, pronunciation metadata, settings and context fingerprint. Request/session IDs and prefetch priority do not affect it. Reordering context-independent speech reuses its audio.

Workers remain warm for two minutes after the last request, then exit. Loading another engine drops the previous model. Another window can claim an idle worker but cannot evict one doing a speech job. A native memory-pressure source exits the helper even during inference; the next uncached request reloads the model. Cancellation kills a busy helper. Audio remains in a separate 256 MB LRU cache, with WAV validation and a 16 MB utterance limit. Cache hits refresh recency.

The helper runs under a macOS `sandbox-exec` policy denying network access, with Hugging Face/Transformers offline flags as additional hints. Phonon uses `load(from:)`; Ming and Qwen use `fromModelDirectory`. Kokoro's dependency can attempt to recover missing assets, but the process policy denies network access. Missing assets fail instead of downloading during synthesis. Failure to apply the sandbox fails worker startup; there is no unsandboxed fallback.

## Verification and remaining acceptance

Node tests use synthetic bytes, fake workers and installed-system patterns. They cover manifest validation, checksum refusal, interrupted range resume, range rejection/restart, removal/disk reporting, cache components, warm/idle/pressure/switch behavior, writer activity, offline reloads, immutable references, design-once/Base reuse, metadata validation and catalogue tags. A separate native policy test attempts an HTTP connection from a fake helper and requires zero server requests. This test skips when the host forbids `sandbox-exec`, as this sandbox does.

The Electron tests add plain-data/activity checks, deterministic fake-adapter engine-picker playback, and stubbed pack confirmation, progress/cancel, checksum retry, removal, low-memory consent and design/regenerate/keep flows. In this sandbox Electron exits with `SIGABRT` during launch, so those flows could not execute. Real model downloads, reference rendering, sound quality, signed packaging and the native network-denial test remain hardware/CI acceptance work.

TypeScript checks and the production desktop build pass. Build the helper with the default SwiftPM build system:

```sh
cd native/voice-helper
swift build -c release
```

Do not pass `--build-system native`. That build system emits no Metal library, and the helper then dies at load with "Failed to load the default metallib" for every engine, Phonon and Kokoro included. The working build puts the library at `.build/release/mlx-swift_Cmlx.bundle/Contents/Resources/default.metallib`. The packaging script copies every `*.bundle` next to the helper and fails if that file is missing. If the build sandbox blocks Metal's module cache under `~/.cache`, point `CLANG_MODULE_CACHE_PATH` and `SWIFTPM_MODULECACHE_OVERRIDE` at a writable directory rather than switching build systems.

The root `npm test` run completed with failures in existing relay/phone/collaboration tests because this sandbox denies binding loopback sockets (`listen EPERM`). One existing sync-folder watcher test also timed out. The targeted voice/table-read suites pass; the native sandbox policy test is explicitly skipped here. These failures are not counted as successful validation.

## Output checks, loudness and notices

Every line from the helper passes through `SpeechAudio` before it is returned, so the 16 MB WAV cache never sees an unchecked render. A render is rejected when it is near-silent (peak under -40 dBFS), has more than 2 s of silence before or after the speech, runs longer than `0.9 x words + 3.5` s or (for six words or more) shorter than `words / 7` s, or ends while the signal is still loud. Seeded engines (Qwen, Phonon, and Ming at a temperature above 0) retry up to twice with a different seed. If all attempts fail the request returns an error and nothing is cached. Kokoro and temperature-0 Ming are deterministic, so they get one attempt.

Accepted audio is scaled to -20 LUFS integrated (BS.1770 K-weighting, gated; short clips use the whole clip), with gain reduced as needed to keep the 4x-oversampled true peak under -1 dBTP. Mac voices come from `/usr/bin/say` in the main process, not the helper, and are not normalized.

Each pack installs `notices/NOTICE.txt` next to the weights. It is generated from the pinned manifest (license, provenance, source repo and revision, license URL, and the CC BY 4.0 attribution statement for Phonon) and is checked on every verification, like the weight files.
