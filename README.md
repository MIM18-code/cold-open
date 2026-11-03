# Cold Open

A free, open-source screenwriting app for the Mac.

Cold Open writes screenplays with Final Draft's elements and keyboard flow, paginates the way Final Draft does, and
opens and saves Final Draft (.fdx) files, keeping the Final Draft data it doesn't edit. It also reads and writes
Fountain, which has no place for some of that data (revision colors, tags, locked scene numbers). Its own `.screenplay`
format is a collaborative document, so co-writers on the same network, a paired iPhone and the Backlot production
app can all follow the same script.

What's in it:

- Final Draft-style writing: elements, Tab/Return flow, scene numbers with A-numbers and locks, revisions and
  colored pages, title pages, dual dialogue, script notes and breakdown tags that survive a round trip through FDX.
- Templates for features, one-hour drama, half-hour single-camera, multi-camera and stage plays.
- Story Map and Structure Points, reports, cross-script search, compare and history.
- Live co-writing over the local network or a relay, with presence and conflict notices.
- Dictation that formats screenplay elements as you speak, using the Parakeet speech model included in the Mac app. You can also dictate into the editor with Wispr Flow and choose Format Draft. Screenplay formatting uses a separate local writing model.
- Table reads with local voices (Phonon, Kokoro and others, downloaded on request), casting from the script.
- Optional AI: proofreading suggestions, questions about the script, casting help and sentence completion. It runs
  on a local model through Ollama, or on ChatGPT (Sign in with ChatGPT) or your own Anthropic, OpenAI or Google key.
  Nothing is applied without you accepting it, and sentence completion is off until you turn it on.
- An iPhone remote that reads the live script and sends notes and dictated takes back for review.

## Download

Cold Open is in beta. Download the signed and notarized app from
[mindinmotionsoftware.com](https://mindinmotionsoftware.com) or this repository's
[releases](https://github.com/MIM18-code/cold-open/releases), or install it with Homebrew:

```bash
brew tap MIM18-code/cold-open
brew trust MIM18-code/cold-open
brew install --cask cold-open
```

It needs an Apple silicon Mac running macOS 14 Sonoma or later. Local table-read voices need macOS 15.

## User guide

[Read the Cold Open guide](https://mindinmotionsoftware.com/guides/cold-open/index.html) for getting started, writing, AI setup, co-writing and troubleshooting. It includes screenshots, captioned walkthroughs and sample scripts. [Download the complete guide](https://mindinmotionsoftware.com/downloads/ColdOpen-user-guide.zip) to read it and watch the videos offline.

## Build from source

Needs macOS and Node 22.18 or newer.

```bash
npm ci                            # install the locked workspace dependencies
npm run build                     # bundle the app into apps/desktop/dist
npm start                         # build and open the app
```

Dictation and local voices use two Swift helpers:

```bash
sh scripts/build-helpers.sh       # release builds of native/speech-helper and native/voice-helper
```

## Test

```bash
npm run typecheck                         # every workspace
npm test                                  # unit tests in every workspace
node apps/desktop/scripts/build.mjs       # build once before the end-to-end tests
cd apps/desktop && npx playwright test    # end to end; windows stay hidden
```

## Package

```bash
npm run package -w @screenplay/desktop    # an unsigned Cold Open.app and .dmg in apps/desktop/release
```

A signed release needs `SCREENPLAY_RELEASE=1`, `SCREENPLAY_SIGN=developer-id`, both compiled helpers and
notarization credentials (`APPLE_KEYCHAIN_PROFILE`). `npm run release:prepare` builds it, prepares this source
snapshot and the native source archives, and checks the result. Before preparing release files it runs
`npm run test:packaged` against the built app in disposable profiles. That gate exercises core file/PDF
workflows and bundled speech inference with network access and the user's FluidAudio cache denied to
the speech helper. The screenplay fixtures and attributed speech sample are included with this source.

## Layout

| Path | What it is |
| --- | --- |
| `apps/desktop` | The Electron app (React, Vite, ProseMirror over the shared document). See [docs/app-architecture.md](docs/app-architecture.md). |
| `apps/mobile` | The iPhone remote. See [its README](apps/mobile/README.md). |
| `packages/engine` | The screenplay engine: document model, FDX, Fountain, pagination, structure, reports, compare, proofreading. MIT. |
| `packages/relay` | The co-writing relay; also runs standalone for writers who are not on one network. See [docs/sync-protocol.md](docs/sync-protocol.md). MIT. |
| `packages/dictation` | Transcript-to-screenplay formatting and the speech helper client. MIT. |
| `native/speech-helper` | The Swift speech helper (Parakeet through Core ML, Apple speech). |
| `native/voice-helper` | The Swift voice helper for local table-read voices (MLX). |

## License

Cold Open is licensed under the GNU General Public License, version 3 only (see [LICENSE](LICENSE) and
[COPYRIGHT](COPYRIGHT)). The engine, relay and dictation packages are MIT. Third-party components keep their own
licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), [docs/NATIVE_SOURCE.md](docs/NATIVE_SOURCE.md) and
[docs/OPTIONAL_DOWNLOADS.md](docs/OPTIONAL_DOWNLOADS.md).
