# Document templates

`Format > Document Layout and Templates…` applies one of five templates to the open script. `File > New from Template…` starts a new script with one. A template sets the page drawing, the page breaks the format needs, the scene-number convention and, for a new script, its act structure.

Templates are stored in the document (`meta.template`) and as Final Draft `ElementSettings` and `PageLayout` nodes. The editor, pagination, PDF export and FDX export all read the same values. Template identity is kept in `.screenplay` files. An exported FDX keeps the layout, current page breaks and scene numbers, but not the template name, because FDX has no field for it.

## What each template sets

All templates start from the US Letter screenplay page: 1 inch top and bottom margins, 1.5 inch action margin, 1 to 7.5 inch text area, 12 point Courier equivalent. Only the differences are listed.

| Template | Page drawing | Page breaks | Scene numbers |
| --- | --- | --- | --- |
| Feature screenplay | Final Draft screenplay defaults | None added | 1, 2, 3 |
| One-hour TV drama | Screenplay defaults, centered underlined New Act and End of Act | Before every New Act | 1, 2, 3 |
| Half-hour single-camera comedy | Screenplay defaults, centered underlined New Act and End of Act | Before every New Act | 1, 2, 3 |
| Multi-camera sitcom | Double-spaced dialogue and parentheticals, capitalized action and parentheticals, underlined scene headings, capitalized transitions | Before every New Act and every scene heading, except the scene directly under an act heading | A, B, C, then AA, AB |
| Stage play | Centered character names, 1.5 to 7 inch dialogue, 1.75 inch indented italic action, centered scene and act headings | Before every New Act | 1, 2, 3 |

The multi-camera template can underline action sentences that say a character enters or exits. The stage template can put action paragraphs in parentheses. Both changes happen inside the same undo step as the layout.

### Act structure for new scripts

| Template | Structure |
| --- | --- |
| One-hour TV drama | TEASER with a scene heading and END OF TEASER, then ACT ONE to ACT FIVE with END OF ACT |
| Half-hour single-camera comedy | COLD OPEN with a scene heading and END OF COLD OPEN, ACT ONE to ACT THREE with END OF ACT, then TAG and END OF TAG |
| Multi-camera sitcom | COLD OPEN with a scene heading and END OF COLD OPEN, ACT ONE and ACT TWO with END OF ACT, then TAG and END OF TAG |
| Stage play | ACT ONE and SCENE 1 |
| Feature screenplay | One empty scene heading |

Act counts are starting points. Add, remove or rename act paragraphs with New Act and End of Act; nothing in the template depends on a fixed number of acts.

## Applying to an existing script

`Format > Document Layout and Templates…` reformats the open script in one undoable edit. It keeps every word and paragraph type. It does not insert act headings into an existing script, because where the act breaks fall is an editorial decision. The template's page breaks apply to existing New Act and scene-heading paragraphs immediately. `Number Scenes` then uses the template's numbering convention.

Two optional text changes are offered in the dialog:

- Multi-camera: underline action sentences containing `enters`, `exits`, `entering` or `exiting`.
- Stage: wrap action paragraphs in parentheses, unless they already start and end with parentheses or brackets.

Undo restores the previous layout, the previous template rule and the previous run formatting as one step.

## Numbering

`Script > Number Scenes` follows the document template. Multi-camera scripts number `A`, `B`, `C`, and then `AA`, `AB`; the letters print in the scene-number margin, which is where this app prints scene numbers. Other templates number `1`, `2`, `3`. Locked scene numbers keep the existing labels and give added scenes the next free label between their neighbours, using the same alphabet for multi-camera.

## Export

- **PDF** paginates through `scriptPaginationOptions`, which adds the template's page breaks to the document's FDX layout. A one-hour act starts a page; a multi-camera scene starts a page; a stage act starts a page.
- **FDX** writes the template's `ElementSettings` with Final Draft's element names: Scene Heading, Action, Character, Parenthetical, Dialogue, Transition, Shot, General, Lyrics, Cast List, New Act, End of Act. It writes `PageLayout` margins, and `StartsNewPage="Yes"` on the paragraphs the template breaks before. A scene heading directly under a New Act heading is left on the act page.
- **Fountain** has no layout or page-break syntax, so it keeps the words only. New Act and End of Act already export as action, as documented in the parity notes.

## Conventions and sources

- **One-hour drama act structure.** The Writers Guild Foundation traces episodic drama from teaser plus three acts through four acts, teaser plus four acts, teaser plus five acts, and six acts. Teaser plus five acts is described as the common current structure. See the WGF article [TV Format Fundamentals: Episodic Drama](https://www.wgfoundation.org/blog/2021/10/18/episodic-drama).
- **Half-hour single-camera comedy.** The same series documents two acts plus teaser and tag, three acts, and the modern cold open plus four acts. Cold open plus three acts plus tag is the model used here, following *The Office* and *Broad City* examples in [TV Format Fundamentals: Single-Cam Sitcoms](https://www.wgfoundation.org/blog/2021/11/1/single-cam-sitcoms).
- **Multi-camera act structure.** *Living Single* uses teaser, two acts and tag, and its scene letters continue through the episode (A through L). The same article notes that most multi-camera scripts list the characters under the scene heading. See [TV Format Fundamentals: Multi-Cam Sitcoms](https://www.wgfoundation.org/blog/2021/10/12/multi-cam-sitcoms) and [ScriptLix: TV Script Format](https://scriptlix.com/tv-script-format).
- **Multi-camera page rules.** All action in capitals, double-spaced dialogue, underlined scene headings, character entrances and exits underlined (the name and the verb, "MAYA ENTERS"), parentheticals capitalized and set with the dialogue, acts on new pages, and a page per scene. See [Screenwriting.io: How are multicamera TV scripts formatted?](https://screenwriting.io/how-are-multicamera-tv-scripts-formatted/), [Anton Schettini: How To Format Your Multi-Cam Script](https://www.antonschettini.com/post/tv-writing-101-how-to-format-your-multi-cam-script), and [Industrial Scripts: Multi-Camera Scripts](https://industrialscripts.com/multi-camera/).
- **Stage play format.** Centered character names in capitals, wide dialogue, indented italic stage directions, centered act and scene headings, and each act on a new page. See [ScriptLix: Play Script Format](https://scriptlix.com/play-script-format) and [ScriptLix: Stage Play Template](https://scriptlix.com/templates/stage-play-template).
- **Final Draft mapping.** Element names and `ElementSettings` follow Final Draft's own names, as already used by the engine's FDX reader and writer. The page geometry starts from the Final Draft 13 defaults measured in `packages/engine/src/layout.ts`.

## Deliberate limits

- Act and scene headings start at the top margin. The app cannot drop a multi-camera act heading a third of the way down the page as some shows do.
- No per-show template editor beyond the existing element and margin fields. A show's own margins can be typed over the template before Apply.
- No automatic cast list under a multi-camera scene heading, no day tracking (`D-1`, `N-2`), and no act and scene in the page header. Those are show-specific, and the app has one header line.
- Existing scripts keep their act breaks. Adding or moving them is manual.
- `Format > Underline Entrances` underlines entrances and exits written since the template was applied, as one undo step; it skips ones already underlined, so running it again changes nothing. A first entrance ("MARY ENTERS" before MARY speaks) is underlined from the capitalized word before the verb. Pronouns, words after an article or "OF" ("THE DOOR", "SOUND OF TRAFFIC") and noun phrases like "FIRE EXIT" are not. Nothing is underlined automatically as you type. Stage-direction parentheses still run only when the template is applied.
- New TV scripts put one empty scene heading in the first act and an empty line in each later act, so the scene list starts with one scene instead of a numbered untitled scene per act.
- Stage scripts commonly leave long stage directions unparenthesized in published editions. The parentheses option is off until the writer chooses it.
- FDX does not carry the template name, so reopening an exported FDX does not restore multi-camera scene numbering for newly added scenes. The existing scene numbers, layout and page breaks are kept.
