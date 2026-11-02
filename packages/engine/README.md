# @screenplay/engine

The shared screenplay engine: a collaborative document model with stable scene and paragraph IDs, FDX and Fountain import and export, Final Draft pagination, production revisions and locked pages, structure editing, reports, draft comparison and proofreading. The screenwriting app, Backlot and the phone remote all use it. MIT licensed.

```ts
import { ScreenplayDoc, parseFdx, writeFdx, parseFountain, writeFountain } from "@screenplay/engine";

const doc = ScreenplayDoc.fromScript(parseFdx(xml));
for (const scene of doc.scenes()) console.log(scene.sceneId, scene.heading);
const fdx = writeFdx(doc.toScript());
```

## Why Yjs

The document is a [Yjs](https://github.com/yjs/yjs) CRDT (13.6, the current stable line). The other candidates were Automerge 3 and Loro. Yjs won on three points:

- **It is plain JavaScript.** Automerge and Loro are Rust compiled to WebAssembly. React Native's Hermes engine has historically had no WebAssembly; support is only now arriving (reported for React Native 0.84) and is unproven. The phone remote is meant to share this engine, and a pure-JavaScript core runs there today without depending on it.
- **The pieces for live editing exist.** The awareness protocol gives shared cursors, and Y.Text's attributed-line model is the one Quill-style editors bind to.
- **Sync is transport-agnostic.** Updates are byte arrays that merge in any order, which fits the plan: peer-to-peer and a shared iCloud or Dropbox folder first, a self-hostable relay later. Yjs has existing providers for WebRTC and WebSocket.

Yjs also lacks a move operation. Moving a scene is a delete and re-insert that keeps every ID; see the caveat under Structure.

## The document

A flat, ordered list of paragraphs. Each has a random UUID that never changes, a type (`sceneHeading`, `action`, `character`, `parenthetical`, `dialogue`, `transition`, `shot`, `general`, `lyrics`, `castList`, `newAct`, `endOfAct`, plus Fountain's non-printing `section`, `synopsis` and `note`), and formatted text runs. Scenes are derived from scene headings, so adding or removing a heading never moves a paragraph. A heading carries a `sceneId`, which defaults to its own paragraph ID and survives retyping.

Inside the Y.Doc, `meta` holds the schema version, the title page and document-level FDX data. The whole script is one Y.Text, `body`. Each paragraph starts with a line break, and the paragraph's ID, type and other fields are attributes on that line break; characters carry the run marks. A line break inside a paragraph is a line break marked `soft`. `src/doc.ts` has the full layout.

Because the script is one text and each paragraph's identity sits on its own leading line break, splitting inserts a new break with a new ID and joining deletes a break. Nothing is copied, so concurrent typing, splits and joins merge without losing text or duplicating IDs (tested with two replicas). The y-prosemirror binding does not fit this layout, so the app's editor draws ProseMirror from the engine's paragraphs and turns every keystroke into engine operations on the Y.Text.

Editing operations keep IDs with the text a writer would expect: splitting a paragraph keeps the ID on the first half, Return at the start of a paragraph inserts a new one above, and Backspace into an empty paragraph removes the empty one.

## FDX

`parseFdx` keeps everything Final Draft writes. What the model understands (types, text, style flags, scene numbers, alignment, page breaks, dual dialogue) becomes fields; everything else (scene properties, arc beats, element settings, title page, revisions, fonts, revision IDs, tags) is kept as raw XML and written back unchanged. Final Draft's own paragraph IDs become the model's IDs, so a script that goes out to Final Draft and comes back keeps its links to Backlot. Duplicate or malformed IDs are replaced.

Files that are not valid FDX but that other tools write (bare text in a paragraph, a `<Paragraphs>` wrapper) are repaired on import, with a message in `options.warnings`. So are characters XML 1.0 does not allow (most control characters, raw or as references) and text left after `</FinalDraft>`. Export never writes those characters: vertical tab and form feed become spaces, the others are left out, with a message in `options.warnings`.

A synopsis right after a scene heading is written as the heading's SceneProperties Summary (Final Draft's index card text) and read back; other synopses, sections and notes are skipped with a warning in `options.warnings`.

## Fountain

`parseFountain` and `writeFountain` follow the Fountain 1.1 spec, including forced elements, scene numbers, dual dialogue, centered text, page breaks, lyrics, sections, synopses, notes and boneyard. The writer forces any line that would otherwise read as a different element, and its output always reads back to the same script, so saving and reopening never drifts.

An omitted scene is written as its OMITTED heading followed by a boneyard block whose first line is OMITTED SCENE and which holds the scene as Fountain; reading the file back puts that text inside the OMITTED heading again, so Restore Omitted Scene works after a Fountain save.

Inline `[[notes]]` become note runs inside their paragraph: they stay in the document and in Fountain, and are skipped (with a warning) on FDX export. Inline `/* boneyard */` inside a line is not recognized yet and stays as text.

Fountain carries less than FDX: shots, general text and act markers export as action, two dialogue paragraphs in a row merge into one, and only bold, italic and underline survive. Fountain files have no IDs, so each import gets fresh ones. Matching a re-imported Fountain file to an existing document is a later job.

## Pagination

`paginate(script, options)` lays a script out on pages the way Final Draft does (`src/pagination.ts`, geometry in `src/layout.ts`). The script is cut into groups that move as a unit (a heading, a speech, a dual-dialogue block, an action paragraph); a heading keeps with what follows and a transition with what precedes; a group that does not fit splits only where Final Draft allows, at sentence ends with two lines either side, and a broken speech gets (MORE) and CHARACTER (CONT'D). `fdxPaginationOptions` and `scriptPaginationOptions` read an FDX file's own margins and settings. The result (`Pagination`: pages, lines, breaks) drives the editor's page breaks, PDF export, page counts in reports and scene lengths in eighths (`sceneEighths`, `formatEighths`).

`options.locks` paginates with locked pages (see Revisions): locked pages keep their numbers and their first paragraph, and text added to a locked page flows onto A-pages (2A, 2B) instead of pushing every later page down. With no text added, locked pagination equals unlocked pagination, line positions included: dual dialogue, (MORE) and CONT'D and scene continueds too. A property test checks random scripts, and all 331 FDX files in the private set reproduce. Each lock is anchored to its page's first character with a Yjs relative position, so it follows insertions, deletions, splits and joins. Locks resolve from the shared document only, never from Yjs's per-replica undo state; after Undo the app moves an anchor onto the restored text (`reanchorPageLocks`).

Against Final Draft 13's own PDFs of nine scripts exported on 30 October 2026: 9 of 9 page counts exact, and 99.5% of page starts on the same paragraph. On an older set of 42 FDX and PDF pairs, 89.2% of page starts agree; many of those PDFs were not printed from the same draft as their FDX file, so that number understates the match. Check it with pairs of an FDX file and Final Draft's PDF of exactly that file, tab separated, one pair per line (needs `pdftotext` from poppler; prints counts and element types only):

```bash
node test/pagination-corpus.ts ~/pairs.tsv [--detail]
```

## Revisions

`src/revisions.ts` has production revisions as Final Draft keeps them. Its header comment documents how Final Draft stores them in FDX, measured on 1,183 files (element and attribute names only):

- `Revisions` holds one `Revision` per set (ID, name, mark, page color). Revised text is a `Text` element with that set's `RevisionID`.
- `DeletedText` lists offsets where text was deleted in a set, so the line still gets a margin mark.
- `LockedPages` lists each locked page's number, its starting position and its lock level.
- An omitted scene is a heading reading OMITTED that keeps its number, with the scene's paragraphs inside an `OmittedScene` element.

What the app does with them: the revision state (sets, the current set, Revision Mode) lives in the document meta under `revisions`, locked pages under `pageLocks`. `markInserted` gives typed or pasted text the current set's RevisionID, `clearRevisionMarks` removes them, `lockPages` and `unlockPages` store the page locks that `paginate` honours, `omitScene` replaces a scene with an OMITTED heading that keeps its number and keeps the text inside it, and `setSceneNumbersLocked` fixes the scene numbers so a new scene between 12 and 13 becomes 12A. Every change also rewrites Final Draft's `Revisions`, `LockedPages` and `SceneNumberOptions` elements in the FDX extras, so FDX export carries them; a script that came from Final Draft and was never changed here reads them straight from those elements. `pageRevisions` tells the printer which pages are revised, with which set's name, date and color.

FDX has no scene number lock field. The app writes the lock, and the numbers the locked draft issued, as `ColdOpenSceneNumbersLocked` and `ColdOpenLockedScenes` attributes on Final Draft's `SceneNumberOptions` element and reads them back. Final Draft 13 drops both when it saves a file and rewrites paragraph IDs, so after a Final Draft round trip the scene numbers survive but the lock has to be set again. `resolveSceneNumberConflicts` gives duplicate numbers their own numbers in script order (12A, 12B, 12AA), leaves every unique number alone, and records a notice under the meta key `sceneNumberRenumbering:<paragraph ID>` that `sceneNumberRenumberings` reads and `dismissSceneNumberRenumberings` clears. On import, Final Draft's `DeletedText` marks move into the paragraphs they fall in, so they follow their text like the app's own, and export writes their current offsets.

## Structure

`src/structure.ts`: scenes as blocks (`sceneBlocks`), moving scenes and sections (`moveScene`, `moveScenes`, `moveSection`), synopses, scene colors stored as Final Draft stores them, per-scene summaries for the navigator and cards (`sceneSummaries`), the section outline (`outlineOf`, `addSection`, `removeSection`) and scene numbering (`numberScenes`, `removeSceneNumbers`). Edits run in one transaction, so wrapping one in the app's `session.edit()` makes one undo step.

**The scene-move caveat.** Yjs has no move. A move deletes the source and inserts a copy with the same paragraph IDs, scene IDs and attributes. In the same transaction, `moveRanges` appends `{ sv, at, spans, chars }` to `move.<clientID>` in meta. The array retains the last eight records, newest last. Each has its own pre-move state vector and post-copy clock. Compact `[client, clock, length]` spans identify only body items that operation deleted; earlier deletions in an enclosing transaction are subtracted. `chars` preserves character lengths and paragraph markers after GC merges text and formatting tombstones. No source text is stored. `strandedByMove(doc, transaction)` evaluates a record only when it arrives in the same transaction as the deletions it describes, which is how `moveRanges` writes it; a record arriving apart from its move is skipped, because it cannot tell concurrent typing from typing done since. Each vector applies only to its own scoped deleted blocks, so other movers, plain deletes and in-place restores cannot borrow it. Only this session's surviving characters absent from that vector qualify, inside those blocks or their directly origin-linked tails. Retained earlier moves remain detectable when later moves acknowledge the typing, and previously received records do not replay. Detection prefers misses to false notices: unrecorded tombstones break blocks, and source attribution is skipped if original copied characters or markers cannot identify it reliably. A record arriving before its deletion, or one dropped beyond the eight-record bound, may be missed. Undo/Redo relocations by the mover write no fresh record, so newly stranded concurrent typing gets no notice in those cases. Native saves retain the arrays; FDX, Fountain and exchange preflight omit them, and `doc.load()` clears them. Notices and dismissals remain only in the typist's running session and disappear on restart or native reopen. The dialog selects the exact text for manual cutting and pasting, links to the scene or explains its absence, and offers Leave it here. There is no automatic recovery. Batched validation removes changed or healed text, skips unrelated typing, and does not resurrect removed notices.

Two writers moving the same scene at the same moment each insert a copy. The document keeps both; the later copy gets new paragraph and scene IDs, made from its line breaks' Yjs IDs so every peer agrees, and the app tells the writer. Nothing typed into either copy is lost (see the top of `src/doc.ts` for why no copy is deleted).

## Reports

`src/reports.ts`, all pure over a plain `Script`: `characterReport`, `sceneReport`, `locationReport`, `scriptStatistics`, `castList`, `sidesScript` (a script of chosen scenes, numbers kept), `planRename` and `applyTextEdits` (Rename Character: cues, extensions such as (V.O.) and mentions in action, as one edit) and `toCsv`. Pass one `Pagination` to several reports so a long script is laid out once; `locationReport` and `scriptStatistics` also take the scene report as an optional third argument, so it is worked out once.

## Compare

`compareScripts(base, revised)` in `src/compare.ts`. Paragraphs match by ID first (drafts of one document, and FDX round trips, share IDs), then by exact text, then by word similarity, so a Fountain file with fresh IDs compares as well. Out-of-order matches are moves. Scenes match by scene ID, then heading, then shared paragraphs. Changed paragraphs carry a word diff (`diffWords`); `insertedRanges` turns it into ranges to highlight in the revised script.

## Proofread

`proofread(paragraphs, options)` in `src/proofread.ts` finds problems without a model: character names that drift from the spelling the script uses most, broken structure (headings without INT. or EXT. or a time of day, cues without dialogue, malformed transitions), unbalanced brackets and quotes, double spaces, doubled words, sentence capitals and common typos. Every finding has a stable ID from its rule, paragraph and text, so an ignore stored in the document keeps working across runs. Spelling uses the platform's checker through `spellingWords` and skips names from `scriptVocabulary`.

## Tests

```bash
npm install
npm test
npm run typecheck
```

The committed fixtures are synthetic. `npm run corpus -- <list>` runs the round trips over real FDX files listed one per line, prints only counts and the first difference per file, and is how the private test set gets checked. Never commit real scripts to this repo.

On a private corpus of 545 real FDX files (745,620 paragraphs, Final Draft versions 1 to 6), on 30 October 2026:

| Check | Result |
| --- | --- |
| FDX → engine → FDX identical after canonicalizing | 542 of 545; the other 3 are invalid files that import repairs |
| FDX → CRDT → plain script unchanged | 545 of 545 |
| Final Draft paragraph IDs kept | 557,389 of 557,389 |
| FDX → Fountain → Fountain stable, no words lost | 545 of 545 |
| Time for all three round trips, all files | about 12 seconds |

Rerun on a larger set of 1,189 files after the revisions work: 1,186 identical and 3 repaired on import; the 3 with text after `</FinalDraft>` now open.

"Canonicalizing" ignores attribute order, layout whitespace, the order of style flags, and a Text element split into neighbours with the same formatting.
