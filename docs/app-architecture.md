# Desktop app architecture

The app is `apps/desktop`: Electron 44, React 19 and Vite 8, on the shared engine in `packages/engine`.

```bash
npm install                      # at the repo root (npm workspaces)
npm run dev                      # Vite dev server + Electron with reload
npm run start                    # build and run
npm run typecheck                # every workspace
npm test                         # unit tests in every workspace
npm run test:e2e -w @screenplay/desktop   # Playwright drives the built app, windows hidden
```

Agents and CI never run `npm run dev` or `npm start`: they put windows on the screen. Build with `node apps/desktop/scripts/build.mjs` and drive the built app through the hidden e2e harness.

## Processes

- **Main** (`src/main`): windows, the application menu, file dialogs and disk I/O, and services that need Node (sync servers, the speech helper, AI providers). Bundled by esbuild (`scripts/build.mjs`).
- **Preload** (`src/preload`): exposes `window.desktop`, a `DesktopBridge` (`src/shared/api.ts`): `invoke(channel, ...args)`, `on(channel, listener)`, and macOS spell checking.
- **Renderer** (`src/renderer`): the whole UI and the document. The engine runs here; FDX, Fountain and PDF are produced here and written to disk through the main process.

The renderer also runs in a plain browser (`npx vite` in `apps/desktop`): `core/platform.ts` substitutes localStorage for settings and downloads for saving. Main-only services are unavailable there.

## Extending

A **feature** is a folder `src/renderer/features/<id>/` with an `index.tsx` whose default export is a `Feature` (`core/app.ts`). Features are discovered by `import.meta.glob`, so adding one edits no shared file. A feature can contribute:

| Field | What it is |
| --- | --- |
| `commands` | Menu items and command-palette entries, with accelerators. `menu` puts one in File, Edit, Format, View, Script, Production or Tools. |
| `views` | Main-area views (Script, Index Cards, Outline), switched from the title bar or Ctrl+Cmd+1…9. |
| `panels` | Left or right sidebar panels. |
| `modals` | Dialogs, opened with `app.openModal(id, props)`. |
| `status`, `toolbar` | Status bar and title bar items. |
| `settings` | Sections of the Settings window (Cmd+,). |
| `activate(app)` | Startup hook, after all features register. |

The features: `editor` (the Script view), `navigator`, `cards`, `outline`, `story-map` (the page timeline and structure points), `print` (PDF, printing, live pagination), `title-page`, `file`, `document-style` (document templates and layout), `reports`, `rename`, `compare`, `revisions` (Revision Mode, revision sets, locked pages and scene numbers), `proofread`, `assistant`, `dictation`, `collab` (co-writing and folder sync) and `workspace` (palette, views, panels, Settings).

Structure points live in the document meta as one key per field (`structurePoint.<id>.name`, `.position`, `.sceneId`); a point exists while its name key does. Co-writers editing different fields of a point keep both edits, and built-in beats share one id across presets (`beat-midpoint`), so two writers applying presets converge on one Midpoint. Two edits to the same field at once resolve like any other concurrent edit: one wins on both copies.

A **main-process service** is `src/main/services/<id>.ts` exporting `register(ctx: ServiceContext)` and is listed in `services/index.ts`. Channels are named `<id>:<operation>`; shared payload types go in `src/shared/channels/<id>.ts`. The services:

| Service | What it does |
| --- | --- |
| `files` | Open and save dialogs, reading and writing files the writer chose (an allow list), recent files, autosave copies. |
| `settings` | `userData/settings.json`, broadcast to every window on change. |
| `spelling` | The macOS spell checker's dictionary (Learn). |
| `print` | PDF from the renderer's drawing, and the system print dialog. |
| `sync` | The embedded co-writing relay for Share, and folder sync through iCloud Drive or Dropbox. |
| `dictation` | The native speech helper and the local formatting model; the microphone permission. |
| `ai` | Ollama, Anthropic, Google and OpenAI over HTTP; API keys stay in the main process. Sign in with ChatGPT signs in through Codex, but requests to it are turned off: Codex 0.166's app-server could not be stopped from reading files outside the request or calling the writer's MCP tools. |

**Quick notes and "Since last time"** (`features/quick-notes`). Cmd+Shift+M (`rewrite.new.note`) opens a small floating box, not a dialog. The note is created in the document meta on the first words, rewritten as the writer types (400 ms pause, and on blur, close, flush and unload) and removed again if the box ends empty. Its mic button records with the dictation `Recorder` and sends the WAV through `dictation:process` with `transcribeOnly`, which returns the heard words and never calls the formatting model. When a script opens, the tray lists unresolved top-level notes created after the writer last worked on it. That time is per script and local to this Mac, in the setting `notes.since.<sha256 of the script's history ID, else its path>` as `{ seenAt, dismissed }`, never in the document. A session reads it once as its baseline, then rewrites it every minute and on leaving; a note that arrived while the tray was closed holds `seenAt` back until it has been shown. A script this Mac has not seen shows nothing. The tray and the box are portals mounted from a toolbar item, so they float above the window and move no layout.

Element-type shortcuts follow Final Draft: Cmd+1 to Cmd+9 (and Cmd+0) set the element type.

### Keyboard shortcuts and the menu

A command with a `menu` is in the native menu with its accelerator. One key press must run it once, so the main process listens to `before-input-event` on each window: a key that matches an enabled menu command's accelerator is cancelled there (Electron documents that this stops both the page's keydown and the menu's key equivalent) and the command is sent to the renderer once. Keys that reach the page (palette-only commands, the browser build, and Playwright's synthetic keys, which do not pass through `before-input-event`) are run by the editor or `App.handleKey`, which cancel the key so the menu cannot run it again. The matcher is shared: `src/shared/accelerator.ts`. It goes by the character the layout typed (Cmd+; on Dvorak is not Cmd+Z) and falls back to the key's position only when Option, a dead key, a non-Latin layout or the digit row changed that character.

Undo and Redo act on the script when the script, or nothing that takes text, has focus. In a text field outside the script (Find, a card synopsis, a setting) they do nothing: Chromium keeps one undo stack per page, shared with the editor's own editable text, so a native undo there could rewrite the script outside the engine (tried: it emptied a typed scene).

Repeated paragraph IDs (two writers moving the same scene at once, or undoing such moves; Yjs has no move) are repaired by ScreenplayDoc itself, which never deletes: a later copy of an ID, a line break without one and a repeated scene ID get an ID made from the line break's Yjs character ID (`y<client>-<clock>`), the same on every peer, with REPAIR_ORIGIN, which undo does not track. Both copies stay in the script; `ScreenplayDoc.onRepair` reports the repair and the editor tells the writer which scene is there twice. A read-only follower leaves repairs to the writers. A line break whose type a concurrent edit dropped gets it back the same way: the type of another copy of the paragraph, or sceneHeading for one with a scene ID and section for one with a depth. Text a co-writer left before the first line break counts as the start of the first paragraph in every text offset (`ScreenplayDoc.lead`).

Scene and section moves delete the source and insert a copy with the same paragraph and scene IDs in one transaction. `moveRanges` appends `{ sv, at, spans, chars }` to `meta["move.<clientID>"]`, retaining the client's last eight records, newest last. `sv` captures the mover's state vector just before that operation; `at` is the clock after copying and before the key write. Compact `[client, clock, length]` spans cover only body items this move actually deleted, subtracting earlier deletions in an enclosing transaction. `chars` preserves the character and paragraph-marker subset after GC merges text and formatting tombstones. Records contain IDs and counters, not source text. Native saves retain the bounded arrays; FDX, Fountain and exchange preflight omit them, and whole-script `doc.load()` clears them.

Each record's vector applies only to that record's deletion spans. Other movers, plain deletions and in-place restores in the same update cannot borrow it. Detection evaluates a record only in the transaction that delivers its own deletions, which is how `moveRanges` writes it; a record arriving apart from its move is skipped, since it cannot tell concurrent typing from typing done after the move arrived. The session observes body and metadata transactions without evaluating one transaction twice. Previously received retained records do not replay as the array grows. Earlier retained operations keep their own vectors even when later moves acknowledge the typing. A candidate must belong to this session's client and be absent from that operation's vector, inside its scoped deleted block or directly origin-linked tail. Unscoped deletions and known surviving text interrupt blocks. Existing merged text and already-synced headings remain excluded. Detection is read-only and makes no relocation or paragraph-type guesses.

False notices take priority over coverage. Unrecorded tombstones interrupt detection, so typing beside an older deleted gap may be missed. Paragraph attribution maps the recorded character IDs to the original moved copy; if that copy has lost characters or cannot identify the source, the record is skipped. A record received before its scoped deletions are present can also be missed. Only eight records per client are retained, so older evidence is dropped; moves predating deletion-span records are not diagnosed. Undo/Redo of a move by the mover is deliberately not recorded. New concurrent typing stranded by an undone or redone move gets no notice. Restoring an older record array is not treated as a new move, preventing false notices and dismissal replay.

`DocumentSession` keeps notices only in memory. The status button reads “Your typing was left behind by a co-writer's move · Review”; Production > Scene Move Conflicts opens the same dialog. Each notice shows the source heading and read-only, selectable text. Show where it is now resolves character identities, reveals the editor location and selects the exact range for cutting. Show the scene reveals the moved heading, or is disabled with a short reason if it is gone. Leave it here drops the notice without changing the document. The writer cuts and pastes manually; there is no automatic placement. Editing, deleting or reformatting the characters invalidates their notice; remote Undo retires it when the text rejoins its source paragraph. Pending notices validate together in one traversal, without repeated delta snapshots, and unrelated keystrokes skip validation. Notices and dismissals do not sync or survive app restarts or native save/reopen; removed notices do not return on Undo/Redo. The shared move keys contain knowledge only, with no notices, dismissals, source-text history or destination anchors. Concurrent move/delete keeps the moved copy, and concurrent moves retain both scene copies with unique repaired IDs for manual selection.

## The document

`core/session.ts`: a `DocumentSession` wraps one `ScreenplayDoc` (one Y.Text, see `packages/engine/README.md`), its path and format, the dirty flag and a `Y.UndoManager`. Every local change runs inside `session.edit(() => ...)`, which tags the transaction with `LOCAL_ORIGIN` so undo tracks it. Remote changes (co-writing, folder sync) are applied with their own origin and are not undoable.

`app.session` is the open document; `app.setSession()` swaps it (Open into an untitled window, Revert, joining a co-writing session). Features that hold document listeners re-subscribe in `app.onSession`. A component that keeps state for the open document (a draft, an ownership check) must reset it when `useSession()` returns a different session: Revert reopens the same file with the same scene and paragraph IDs, so React reuses the components that showed the old one.

Document templates (`features/document-style`, [templates.md](templates.md)) cover feature, one-hour drama, half-hour single-camera comedy, multi-camera sitcom and stage play. A template writes FDX `ElementSettings` and `PageLayout`, records its name in the document meta, and adds its page rules (acts, and every scene in multi-camera) through `scriptPaginationOptions`. `File > New from Template…` starts a new script; `Format > Document Layout and Templates…` reformats an open one in one undo.

**Pending edits.** Some fields hold an edit outside the document until it is finished: the structure views write a section title when the field loses focus and a synopsis after a 600 ms pause, so typing never fights their refresh. Such a field registers a flush with `app.onFlush(fn)` while it is mounted, and `app.flushPending()` runs every flush. Save, Save As, Export (FDX, Fountain, PDF, sides), Print, closing the window, New, Open and `setSession` call `flushPending()` first, so they always see what the writer sees, and a pending draft makes the document dirty before Close decides whether to ask. Code that reads the whole document to write it somewhere (a share, a sync) should call it too.

**Read-only sessions.** `session.readOnly` (set with `session.setReadOnly()`, which notifies `onState` listeners) marks a document the writer may read but not change: the co-writing feature sets it while connected through a read-only invite and clears it on leaving. While it is set, `session.edit()` throws `ReadOnlyError` ("This script is read-only."), the editor is not editable and shows a banner saying so, and editing keys and Undo do nothing. `App.runCommand` shows the error as a toast, and so does a window-wide handler for one thrown from any other click (a dialog's Apply, a panel's Accept), so a refused edit is never silent. Remote updates still apply, since they do not go through `edit()`. A feature with its own editing UI checks `useSessionState().readOnly` and disables it, so the writer sees it can't be changed before trying: the index cards and outline disable their title, synopsis and color fields, dragging and Add section and show a read-only notice; the navigator stops dragging; the Title Page dialog disables its fields and Save; Rename Character, Number Scenes and Remove Scene Numbers are disabled.

React hooks (`core/hooks.ts`): `useApp(select)`, `useSession()`, `useScript(delay)` (a debounced plain `Script`), `useDocVersion()`, `useSessionState()` (path, name, format, dirty, readOnly), `useSetting(key, fallback)`, `useEditor()`.

## The editor bridge

Features never reach into the editor. `core/editor-bridge.ts` defines `EditorBridge`: selection by paragraph ID and offset, reveal, element type, marks, inserting paragraphs, replacing text, and the drawing channels other features feed: `setDecorations(source, …)` (proofreading, find, compare), `setRemoteCursors` (co-writing) and `setPageBreaks` (the print feature's live pagination). The editor feature implements it and calls `app.setEditor()`.

`activeMarks()` returns the bold, italic and underline state at the caret: what typing would continue (including a mark toggled with nothing selected), or the marks that cover the whole selection. `onSelectionChange` fires whenever that can change (the caret moves, the text under it changes, a mark is toggled), so a toolbar reads `activeMarks()` in its listener; the title bar's B, I and U buttons and the Format menu's check marks do.

`replaceText` and `insertParagraphs` are undoable edits through `session.edit()`. Code that edits the document directly must also use `session.edit()`, or use another transaction origin for changes that should not be undoable (sync, file loads).

## Files

`.screenplay` is the native format (`core/fileformat.ts`): a magic number, a JSON header, then the Yjs state. Opening an FDX or Fountain file keeps its path and format, so Save writes the same format back (FDX losslessly). Save As writes `.screenplay`. Dirty documents are copied to `userData/autosave` every 30 seconds and offered back after a crash.

## Layout and pagination

`packages/engine/src/layout.ts` has the page and element geometry (Final Draft defaults, overridden by an FDX file's settings). The editor draws with it and `pagination.ts` prints with it, so the screen and the PDF agree. The script view shrinks its zoom when the window is too narrow for the whole page (down to about a third of full size), and the side panels narrow with the window, so a 900 by 700 window with both panels open still fits the page.

**One pagination for every view.** `features/print/options.ts` turns the printing settings (paper, automatic CONT'D, MORE and CONT'D at breaks) and the script's own FDX layout into pagination options; `paginateForPrint(script, settings, locks)` paginates with them. `sharedPagination` caches that result per script object and settings, and `features/print/live.ts` wraps it for the open document: `currentPagination(app, script?)` and the hook `useCurrentPagination(script)` read the settings and the document's page locks (`pageLocks(doc)`). The editor's page breaks, the status bar, Print Preview, PDF export, the navigator, cards and outline (scene pages and lengths in eighths), Reports, Export Sides and Rename Character all use it, so A4 paper or a locked page moves every page number and eighth together. `session.script()` returns one object per document version, so views that show the same version share one pagination. The editor draws with the same resolved layout as printing (`printOptions`, including the script's FDX element settings and the paper setting), so on-screen margins follow the file.

**Locked pages.** Production > Lock Pages stores the current pages in the document meta. Locked pages are a pagination option: the editor, preview and PDF all paginate with the document's locks, so a locked page keeps its number and text added to it flows onto A-pages (2A). Each page is anchored to its first character, so a page that starts inside a paragraph keeps its text when text is added or removed before it. Production > Omit Scene keeps the omitted scene's paragraphs with its OMITTED heading, and Restore Omitted Scene puts them back.

**PDF fonts.** PDF export uses the PDF standard Courier fonts, which encode WinAnsi (Western European) only. Before exporting, `unprintable()` in `features/print/pdf.ts` finds any other character and the pages it is on, and the writer chooses Export Anyway (those characters print as "?") or Cancel. Text is composed first (NFC), so an accent pasted as its own character after a letter prints as one WinAnsi letter, and the warning names an invisible character by its code (U+200B). Printing goes through Chromium with the system's fonts, so a PDF saved from the Print dialog keeps them. Embedding a Unicode monospace font is a follow-up.

## Security notes

- Only the main frame of the app's own page may call services (`isTrusted` in `src/main/index.ts`).
- Pages read and write files only where the writer chose through a dialog or opened, plus the autosave folder in `userData`. The rest of `userData` (settings, API keys, the chosen dictation helpers) belongs to the main process.
- Programs and files the main process runs or reads for the writer (the speech helper, the Backlot project) are chosen only in a native dialog in the main process and kept under `grants.*` settings, which `settings:set` refuses, as it refuses `files.*`. Codex runs only from its usual install locations.
- The session's permission handlers grant the microphone (audio only) and the clipboard and full screen to the app's own page, and nothing else.
- Paste keeps Final Draft's raw XML extras only from clipboard JSON this window wrote; JSON from anywhere else is rebuilt from known fields.

## End-to-end tests

`apps/desktop/e2e`, run with `npx playwright test` in `apps/desktop` after a build.

- Every window stays hidden: `launch()` in `e2e/helpers.ts` sets `SCREENPLAY_E2E=1`, which keeps windows off screen and the Dock icon away, and answers message boxes without showing them. Tests stub `dialog.showOpenDialog` and `dialog.showSaveDialog` in the main process with `electronApp.evaluate`.
- Close with `close(electronApp, page)`, which marks the document saved so quitting does not wait on a "Save changes?" box nobody can see.
- Drive the app through `window.__app` (commands, views, panels, the session) and the real UI. Prefer the real editor over a stand-in; a stand-in editor must implement the whole `EditorBridge` (including `activeMarks`), and other features (proofreading, revisions) also draw through it, so filter recorded calls by source.
- Message boxes are answered by `globalThis.e2eMessageBox` in the main process when a test sets it (`electronApp.evaluate`), otherwise with Don't Save or the cancel button.
- Playwright's keys go to the page directly and never pass through the main process. To test a real key press as macOS delivers it (menu accelerators), use `webContents.sendInputEvent` from the main process, as `e2e/workday.spec.ts` does.
- Dictation runs against a fake helper and a fake model server (`e2e/fakes.ts`). Co-writing runs two app instances.
- `e2e/workday.spec.ts` follows a writer's day through every feature in one window; `e2e/cowriting.spec.ts` has two writers in real editors. `e2e/screens.spec.ts` takes screenshots of every view, panel and modal in light and dark at two sizes when `SCREENPLAY_SCREENSHOTS` names a folder.
- Opt-in checks against real services: `SCREENPLAY_LIVE_AI=1 node --test test/ai-live.test.ts` (one tiny call per provider; keys from the environment or `~/.env`), and `test/dictation-integration.test.ts`, which uses the real helper and Ollama when they are installed and skips otherwise.
