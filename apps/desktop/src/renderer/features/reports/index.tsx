// Tools > Reports (characters, scenes, locations, statistics, each exportable as CSV) and File > Export Sides.
import {
  type CharacterRow, type LocationRow, type SceneRow, type ScriptStatistics, characterReport, formatEighths, locationReport, sceneReport,
  scriptStatistics, sidesScript, toCsv, writeFdx, writeFountain, dialogueReport, notesReport, elementReport, sceneSpeakerReport, reportHtml, type ElementType, type DialogueRow, type NoteRow, type ElementRow, type SceneSpeakerRow, tagReport, tagsByTag, type TagOccurrence, type TagSummary, type ReportLayout,
} from "@screenplay/engine";
import { useEffect, useMemo, useState } from "react";

import { PRINT_CHANNELS } from "../../../shared/channels/print.ts";
import { revealScene } from "../navigator/structure-data.ts";
import { CHANNELS } from "../../../shared/api.ts";
import { app, type Feature, type ModalProps } from "../../core/app.ts";
import { useScript, useSession, useSetting, useApp } from "../../core/hooks.ts";
import { desktop } from "../../core/platform.ts";
import { useCurrentPagination } from "../print/live.ts";
import { type Column, DataTable } from "./DataTable.tsx";
import { sortRows, type SortState } from "./sort.ts";
import "./reports.css";

type Tab = "characters" | "scenes" | "locations" | "statistics" | "dialogue" | "notes" | "elements" | "sceneCast" | "tagsScene" | "tagsTag";
const TABS: { id: Tab; title: string }[] = [
  { id: "characters", title: "Characters" },
  { id: "scenes", title: "Scenes" },
  { id: "locations", title: "Locations" },
  { id: "statistics", title: "Statistics" },
  { id: "dialogue", title: "Dialogue" }, { id: "notes", title: "Notes" },
  { id: "elements", title: "Elements" }, { id: "sceneCast", title: "Scene cast" }, { id: "tagsScene", title: "Tags by scene" }, { id: "tagsTag", title: "Tags by tag" },
];

const characterColumns: Column<CharacterRow>[] = [
  { key: "name", title: "Character", value: (r) => (r.speaking ? r.name : `${r.name} (action only)`) },
  { key: "speeches", title: "Speeches", value: (r) => r.speeches, numeric: true },
  { key: "words", title: "Dialogue words", value: (r) => r.words, numeric: true },
  { key: "scenes", title: "Scenes", value: (r) => r.scenes, numeric: true },
  { key: "dialogueScenes", title: "Scenes with dialogue", value: (r) => r.dialogueScenes, numeric: true },
  { key: "firstScene", title: "First scene", value: (r) => r.firstScene },
  { key: "lastScene", title: "Last scene", value: (r) => r.lastScene },
  { key: "firstPage", title: "First page", value: (r) => r.firstPage },
  { key: "lastPage", title: "Last page", value: (r) => r.lastPage },
  { key: "pages", title: "Pages", value: (r) => r.pages, numeric: true },
];

const sceneColumns: Column<SceneRow>[] = [
  { key: "number", title: "Scene", value: (r) => r.number },
  { key: "heading", title: "Heading", value: (r) => r.heading },
  { key: "setting", title: "INT/EXT", value: (r) => r.setting },
  { key: "location", title: "Location", value: (r) => r.location },
  { key: "timeOfDay", title: "Time of day", value: (r) => r.timeOfDay },
  { key: "page", title: "Page", value: (r) => r.page },
  { key: "length", title: "Length", value: (r) => r.length, sort: (r) => r.eighths, numeric: true },
  { key: "eighths", title: "Eighths", value: (r) => r.eighths, numeric: true },
  { key: "words", title: "Words", value: (r) => r.words, numeric: true },
  { key: "characters", title: "Characters", value: (r) => r.characters.join(", ") },
];

const locationColumns: Column<LocationRow>[] = [
  { key: "location", title: "Location", value: (r) => r.location },
  { key: "setting", title: "INT/EXT", value: (r) => r.setting },
  { key: "scenes", title: "Scenes", value: (r) => r.scenes, numeric: true },
  { key: "length", title: "Length", value: (r) => r.length, sort: (r) => r.eighths, numeric: true },
  { key: "eighths", title: "Eighths", value: (r) => r.eighths, numeric: true },
  { key: "sceneNumbers", title: "Scene numbers", value: (r) => r.sceneNumbers.join(", ") },
];

const ELEMENT_NAMES: Record<string, string> = {
  sceneHeading: "Scene headings", action: "Action", character: "Character cues", parenthetical: "Parentheticals", dialogue: "Dialogue",
  transition: "Transitions", shot: "Shots", general: "General", lyrics: "Lyrics", castList: "Cast list", newAct: "New act", endOfAct: "End of act",
};

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
const percent = (share: number) => `${(share * 100).toFixed(1)}%`;

function statisticsRows(stats: ScriptStatistics): { metrics: [string, string | number][]; elements: [string, number][] } {
  const metrics: [string, string | number][] = [
    ["Pages", stats.pages],
    ["Scenes", stats.scenes],
    ["Words", stats.words],
    ["Dialogue words", stats.dialogueWords],
    ["Action words", stats.actionWords],
    ["Dialogue share (of dialogue and action)", percent(stats.dialogueShare)],
    ["Action share (of dialogue and action)", percent(stats.actionShare)],
    ["Speaking characters", stats.speakingCharacters],
    ["Locations", stats.locations],
    ["Total scene length", formatEighths(stats.eighths)],
    ["Average scene length", `${stats.averageSceneEighths.toFixed(1)} eighths`],
    ["Longest scene", stats.longestScene ? `${stats.longestScene.number}: ${stats.longestScene.heading} (${formatEighths(stats.longestScene.eighths)})` : "None"],
  ];
  const elements = Object.entries(stats.elements).map(([type, count]): [string, number] => [ELEMENT_NAMES[type] ?? type, count ?? 0]);
  return { metrics, elements };
}

async function saveText(title: string, defaultPath: string, filters: { name: string; extensions: string[] }[], text: string): Promise<string | null> {
  const path = await desktop.invoke<string | null>(CHANNELS.saveDialog, { title, defaultPath, filters });
  if (!path) return null;
  await desktop.invoke(CHANNELS.writeFile, path, text);
  return path;
}

async function exportCsv(name: string, header: string[], rows: (string | number)[][]): Promise<void> {
  const path = await saveText("Export CSV", `${app.session.name} ${name}.csv`, [{ name: "CSV", extensions: ["csv"] }], toCsv(header, rows));
  if (path) app.toast(`Exported ${path.split("/").pop()}`, "success");
}

const dialogueColumns: Column<DialogueRow>[] = [
  { key: "character", title: "Character / extension", value: (r) => r.cue },
  { key: "scene", title: "Scene", value: (r) => r.scene }, { key: "page", title: "Page", value: (r) => r.page },
  { key: "parenthetical", title: "Directions", value: (r) => r.parenthetical },
  { key: "dialogue", title: "Complete speech", value: (r) => r.dialogue },
  { key: "words", title: "Words", value: (r) => r.words, numeric: true },
];
const noteColumns: Column<NoteRow>[] = [
  { key: "scene", title: "Scene", value: (r) => r.scene }, { key: "page", title: "Page", value: (r) => r.page },
  { key: "kind", title: "Kind", value: (r) => r.kind }, { key: "text", title: "Note", value: (r) => r.text },
];
const elementColumns: Column<ElementRow>[] = [
  { key: "scene", title: "Scene", value: (r) => r.scene }, { key: "page", title: "Page", value: (r) => r.page },
  { key: "type", title: "Element", value: (r) => ELEMENT_NAMES[r.type] ?? r.type }, { key: "text", title: "Text", value: (r) => r.text },
];
const sceneCastColumns: Column<SceneSpeakerRow>[] = [
  { key: "scene", title: "Scene", value: (r) => r.scene }, { key: "heading", title: "Heading", value: (r) => r.heading },
  { key: "character", title: "Speaking character", value: (r) => r.character }, { key: "page", title: "First dialogue page", value: (r) => r.page },
  { key: "speeches", title: "Speeches", value: (r) => r.speeches, numeric: true }, { key: "words", title: "Words", value: (r) => r.words, numeric: true },
];
const tagColumns: Column<TagOccurrence>[] = [
  { key: "scene", title: "Scene", value: (r) => r.scene }, { key: "heading", title: "Heading", value: (r) => r.heading },
  { key: "page", title: "Page", value: (r) => r.page }, { key: "category", title: "Category", value: (r) => r.category },
  { key: "label", title: "Tag", value: (r) => r.label }, { key: "text", title: "Tagged text", value: (r) => r.text },
];
const tagSummaryColumns: Column<TagSummary>[] = [
  { key: "category", title: "Category", value: (r) => r.category }, { key: "label", title: "Tag", value: (r) => r.label },
  { key: "occurrences", title: "Occurrences", value: (r) => r.occurrences, numeric: true },
  { key: "scenes", title: "Scenes", value: (r) => r.scenes }, { key: "pages", title: "Pages", value: (r) => r.pages },
];
type ReportViewState = { tab: Tab; query: string; sort: SortState | null; character: string; monologues: boolean; element: ElementType; hidden?: Record<string, string[]>; widths?: Record<string, number>; layout?: ReportLayout; selected?: string };
const reportViews = new WeakMap<ReturnType<typeof useSession>, ReportViewState>();
function ReportsModal() {
  const session = useSession();
  const previous = reportViews.get(session);
  const script = useScript();
  const [tab, setTab] = useState<Tab>(previous?.tab ?? "characters"), [query, setQuery] = useState(previous?.query ?? "");
  const [sort, setSort] = useState<SortState | null>(previous?.sort ?? null);
  const [character, setCharacter] = useState(previous?.character ?? ""), [monologues, setMonologues] = useState(previous?.monologues ?? false);
  const [element, setElement] = useState<ElementType>(previous?.element ?? "action"), [error, setError] = useState("");
  // Closing a report to inspect its source does not discard the working filter, tab or sort.
  const [hidden,setHidden] = useState<Record<string,string[]>>(previous?.hidden??{}), [widths,setWidths] = useState<Record<string,number>>(previous?.widths??{});
  const [layout,setLayout] = useState<ReportLayout>(previous?.layout??{paper:"letter",landscape:false,layout:"table",revision:""}), [selected,setSelected] = useState(previous?.selected??"");
  const [preview,setPreview] = useState(false), [presetName,setPresetName] = useState("");
  const [presets,setPresets] = useSetting<{name:string;state:ReportViewState}[]>("reports.presets",[]);
  const viewState = {tab,query,sort,character,monologues,element,hidden,widths,layout,selected};
  useEffect(()=>{reportViews.set(session,viewState);},[session,tab,query,sort,character,monologues,element,hidden,widths,layout,selected]);
  const pagination = useCurrentPagination(script);
  const data = useMemo(() => {
    const scenes = sceneReport(script, pagination);
    return { characters: characterReport(script, pagination), scenes,
      locations: locationReport(script, pagination, scenes), stats: scriptStatistics(script, pagination, scenes),
      dialogue: dialogueReport(script, pagination), notes: notesReport(script, pagination), sceneCast: sceneSpeakerReport(script, pagination), tags: tagReport(script, pagination) };
  }, [script, pagination]);
  const stats = statisticsRows(data.stats);
  // All exports use the filtered set, not only the rendered page of rows.
  const project = <T,>(columns: Column<T>[], rows: T[], id: (r: T, i: number) => string, target: (r: T) => string) => ({
    columns: columns.map((c) => c.title), numeric: columns.map((c) => !!c.numeric),
    rows: rows.map((r, i) => ({ id: id(r, i), target: target(r), cells: columns.map((c) => c.value(r)), order: columns.map((c) => (c.sort ?? c.value)(r)) })),
  });
  const table = tab === "characters" ? project(characterColumns, data.characters, (r) => r.name, (r) => r.firstParagraphId)
    : tab === "scenes" ? project(sceneColumns, data.scenes, (r) => r.sceneId, (r) => r.headingId)
    : tab === "locations" ? project(locationColumns, data.locations, (r) => `${r.setting}|${r.location}`, (r) => r.firstHeadingId)
    : tab === "dialogue" ? project(dialogueColumns, data.dialogue.filter((r) => (!character || r.character === character) && (!monologues || r.monologue)), (r) => r.paragraphId, (r) => r.paragraphId)
    : tab === "notes" ? project(noteColumns, data.notes, (r, i) => `${r.paragraphId}:${i}`, (r) => r.paragraphId)
    : tab === "elements" ? project(elementColumns, elementReport(script, pagination, new Set([element])), (r) => r.paragraphId, (r) => r.paragraphId)
    : tab === "sceneCast" ? project(sceneCastColumns, data.sceneCast, (r) => `${r.sceneId}:${r.character}`, (r) => r.paragraphId)
    : tab === "tagsScene" ? project(tagColumns, data.tags, (r, i) => `${r.paragraphId}:${i}`, (r) => r.paragraphId)
    : tab === "tagsTag" ? project(tagSummaryColumns, tagsByTag(data.tags), (r) => r.number, (r) => r.paragraphId)
    : { columns: ["Metric", "Value"], numeric: [false, false], rows: [...stats.metrics, ...stats.elements].map((cells, i) => ({ id: String(i), target: "", cells, order: cells })) };
  const filtered = table.rows.filter((r) => r.cells.some((v) => String(v).toLocaleLowerCase().includes(query.toLocaleLowerCase())));
  const title = `${app.session.name} — ${TABS.find((t) => t.id === tab)!.title}`;
  const handle = (fn: () => Promise<unknown>) => {
    app.flushPending(); setError("");
    // Never export rows from a debounced snapshot after a collaborator or a pending field changed it.
    if (app.session.script() !== script) { setError("The script just changed. Let the report refresh, then export again."); return; }
    void fn().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };
  const visibleIndexes = table.columns.map((_,i)=>i).filter(i=>!(hidden[tab]??[]).includes(String(i)));
  const columns = visibleIndexes.map(i=>table.columns[i]!);
  const values = (row:(typeof filtered)[number]) => visibleIndexes.map(i=>row.cells[i]??"");
  const csv = () => exportCsv(tab, columns, sorted.map(values));
  const html = () => reportHtml(title, columns, sorted.map(values), {...layout,date:new Date().toLocaleDateString(),widths:visibleIndexes.map(i=>widths[`${tab}:${i}`]??150)});
  const print = () => {const size=layout.paper==="a4"?[8.2677,11.6929]:[8.5,11];return desktop.invoke(PRINT_CHANNELS.print,{title,width:size[layout.landscape?1:0],height:size[layout.landscape?0:1],html:html()});};
  const text = () => saveText("Export text report", `${app.session.name} ${tab}.txt`, [{ name:"Text",extensions:["txt"] }], `${title}\n\n`+sorted.map(r=>values(r).map((v,i)=>`${columns[i]}: ${v}`).join("\n")).join("\n\n"));
  const tableColumns: Column<(typeof filtered)[number]>[] = table.columns.map((label, i) => ({ key: String(i), title: label,
    value: (r) => r.cells[i] ?? "", sort: (r) => r.order[i] ?? "", numeric: table.numeric[i] ?? false, width:widths[`${tab}:${i}`] }));
  // Display and every export use identical ordering, including eighths rather than their formatted labels.
  const sorted = sortRows(filtered, tableColumns, sort);
  return <div className="reports-body">
    <div className="reports-tabs" role="tablist" aria-label="Report type" onKeyDown={(e) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
      const index = TABS.findIndex((t) => t.id === tab), next = e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : (index + (e.key === "ArrowRight" ? 1 : -1) + TABS.length) % TABS.length;
      e.preventDefault(); setTab(TABS[next]!.id); setSort(null); (e.currentTarget.children[next] as HTMLButtonElement).focus();
    }}>{TABS.map((t) => <button key={t.id} role="tab" aria-selected={t.id === tab} tabIndex={t.id === tab ? 0 : -1} className={t.id === tab ? "on" : ""} onClick={() => { setTab(t.id); setQuery(""); setSort(null); }}>{t.title}</button>)}</div>
    <div className="reports-toolbar"><span>{plural(data.stats.pages, "page")}, {plural(data.stats.scenes, "scene")}, {plural(data.stats.words, "word")}</span>
      <div className="reports-export"><button className="button" onClick={() => handle(csv)}>Export CSV…</button><button className="button" onClick={() => handle(text)}>Text…</button><button className="button" onClick={() => handle(print)}>Print / PDF…</button></div></div>
    <details><summary>Columns, print layout and report presets</summary><div className="roadmap-grid">
      <label>Paper <select aria-label="Report paper" value={layout.paper??"letter"} onChange={e=>setLayout({...layout,paper:e.target.value as "letter"|"a4"})}><option value="letter">Letter</option><option value="a4">A4</option></select></label>
      <label><input type="checkbox" checked={!!layout.landscape} onChange={e=>setLayout({...layout,landscape:e.target.checked})}/>Landscape</label>
      <label>Layout <select aria-label="Report print layout" value={layout.layout??"table"} onChange={e=>setLayout({...layout,layout:e.target.value as "table"|"speeches"})}><option value="table">Table with repeated headings</option><option value="speeches">Speech / reading layout</option></select></label>
      <label>Revision <input aria-label="Report revision label" maxLength={160} value={layout.revision??""} onChange={e=>setLayout({...layout,revision:e.target.value})}/></label>
      {table.columns.map((label,i)=><label key={`${tab}:${i}`}><input type="checkbox" aria-label={`Show ${label} column`} checked={visibleIndexes.includes(i)} disabled={visibleIndexes.length===1&&visibleIndexes.includes(i)} onChange={e=>setHidden({...hidden,[tab]:e.target.checked?(hidden[tab]??[]).filter(x=>x!==String(i)):[...(hidden[tab]??[]),String(i)]})}/>{label}<input aria-label={`Column width ${label}`} type="number" min={60} max={600} step={10} value={widths[`${tab}:${i}`]??150} onChange={e=>{const n=Number(e.target.value);if(n>=60&&n<=600)setWidths({...widths,[`${tab}:${i}`]:n});}}/></label>)}
      </div><label>Preset name <input aria-label="Report preset name" maxLength={80} value={presetName} onChange={e=>setPresetName(e.target.value)}/></label><button className="button" disabled={!presetName.trim()} onClick={()=>void setPresets([...presets.filter(p=>p.name!==presetName.trim()).slice(-19),{name:presetName.trim(),state:viewState}])}>Save report preset</button>
      <select aria-label="Load report preset" value="" onChange={e=>{const p=presets.find(p=>p.name===e.target.value)?.state;if(!p||!TABS.some(t=>t.id===p.tab))return;setTab(p.tab);setQuery(p.query);setSort(p.sort);setCharacter(p.character);setMonologues(p.monologues);setElement(p.element);setHidden(p.hidden??{});setWidths(p.widths??{});setLayout(p.layout??{});}}><option value="">Load preset…</option>{presets.map(p=><option key={p.name}>{p.name}</option>)}</select>
      <button className="button" onClick={()=>setPreview(!preview)}>{preview?"Hide print preview":"Preview report pages"}</button>
    </details>
    {preview&&<iframe title="Report print preview" sandbox="" srcDoc={html()} style={{width:"100%",height:"45vh",background:"white"}}/>}
    <div className="reports-filters"><input type="search" aria-label="Filter report" placeholder="Filter this report" value={query} onChange={(e) => setQuery(e.target.value)}/>
      {tab === "dialogue" && <><select aria-label="Dialogue character" value={character} onChange={(e) => setCharacter(e.target.value)}><option value="">All characters</option>{data.characters.filter((c) => c.speaking).map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}</select><label><input type="checkbox" checked={monologues} onChange={(e) => setMonologues(e.target.checked)}/>Monologues over 100 words</label></>}
      {tab === "elements" && <select aria-label="Reported element" value={element} onChange={(e) => setElement(e.target.value as ElementType)}>{Object.entries(ELEMENT_NAMES).map(([type, name]) => <option key={type} value={type}>{name}</option>)}</select>}
      <span>{filtered.length} {filtered.length === 1 ? "entry" : "entries"}</span>
    </div>
    {tab === "notes" && <p className="reports-explainer">Includes native, Fountain and imported FDX ScriptNotes. Legacy paragraph notes retain source links. Observed FDX ranges follow source edits. Detached or unsupported ranges are identified without guessed page numbers.</p>}
    {tab === "sceneCast" && <p className="reports-explainer">Speaking presence, not a production day-out-of-days. Silent cast and shoot-day availability require a reviewed production breakdown.</p>}
    {(tab === "tagsScene" || tab === "tagsTag") && <p className="reports-explainer">Imported and authored FDX tags; no automatic breakdown is inferred. Missing categories are explicitly unresolved. Use Tag Selected Text to author tags and Review Draft in Backlot for the production handoff.</p>}
    {tab === "characters" && <p className="reports-explainer">Cast statistics and appearances. Use Dialogue for the character's complete speeches, extensions and parentheticals.</p>}
    {error && <p role="alert">{error}</p>}
    <div className="reports-scroll">
      <DataTable key={tab} columns={tableColumns.filter((_, i) => visibleIndexes.includes(i))} rows={sorted} sort={sort} onSortChange={setSort} rowKey={(r) => r.id} selected={selected} onRowClick={tab === "statistics" ? undefined : (r) => { if (r.target) { setSelected(r.id); reportViews.set(session,{...viewState,selected:r.id}); app.closeModal(); revealScene(r.target); } }}/>
    </div>
  </div>;
}

function SidesModal({ close }: ModalProps) {
  const session = useSession();
  const script = useScript();
  const pagination = useCurrentPagination(script);
  const scenes = useMemo(() => sceneReport(script, pagination), [script, pagination]);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [format, setFormat] = useState<"fdx" | "fountain">("fdx");
  const toggle = (id: string) => setChosen((current) => {
    const next = new Set(current);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  const eighths = scenes.filter((s) => chosen.has(s.sceneId)).reduce((sum, s) => sum + s.eighths, 0);

  const save = async () => {
    app.flushPending();
    const sides = sidesScript(session.script(), chosen);
    const warnings: string[] = [];
    const text = format === "fdx" ? writeFdx(sides, { warnings }) : writeFountain(sides);
    const label = format === "fdx" ? "Final Draft" : "Fountain";
    const path = await saveText("Export Sides", `${session.name} sides.${format}`, [{ name: label, extensions: [format] }], text);
    if (!path) return;
    app.toast(`Exported ${chosen.size} scene${chosen.size === 1 ? "" : "s"} to ${path.split("/").pop()}`, "success");
    close();
  };

  return (
    <div>
      <div className="reports-sides-bar">
        <button className="button" onClick={() => setChosen(new Set(scenes.map((s) => s.sceneId)))}>Select all</button>
        <button className="button" onClick={() => setChosen(new Set())}>Select none</button>
        <span className="spacer" />
        <label className="field">
          <span>Format</span>
          <select value={format} onChange={(event) => setFormat(event.target.value as "fdx" | "fountain")}>
            <option value="fdx">Final Draft (.fdx)</option>
            <option value="fountain">Fountain (.fountain)</option>
          </select>
        </label>
      </div>
      <div className="reports-sides-list">
        {scenes.map((scene) => (
          <label key={scene.sceneId} className="reports-sides-row">
            <input type="checkbox" checked={chosen.has(scene.sceneId)} onChange={() => toggle(scene.sceneId)} aria-label={`Scene ${scene.number}`} />
            <span className="num">{scene.number}</span>
            <span>{scene.heading || "(empty heading)"}</span>
            <span className="len">{scene.length}</span>
          </label>
        ))}
        {!scenes.length ? <div className="empty-note">This script has no scenes.</div> : null}
      </div>
      <div className="modal-actions">
        <span style={{ marginRight: "auto", color: "var(--ink-2)" }}>
          {chosen.size} of {scenes.length} scenes selected{chosen.size ? `, about ${formatEighths(eighths)} page${eighths > 8 ? "s" : ""}` : ""}
        </span>
        <button className="button" onClick={close}>Cancel</button>
        <button className="button primary" disabled={!chosen.size} onClick={() => void save()}>Export…</button>
      </div>
    </div>
  );
}

function ReturnToReport(){const s=useSession();useApp(a=>a.ui.modal);return reportViews.has(s)?<button className="button" onClick={()=>app.openModal("reports.main")}>Return to report</button>:null;}

const feature: Feature = {
  id: "reports",
  status:[{id:"reports.return",order:85,component:ReturnToReport}],
  commands: [
    { id: "reports.open", label: "Reports…", menu: "Tools", group: "reports", run: (a) => { a.flushPending(); a.openModal("reports.main"); } },
    { id: "reports.sides", label: "Export Sides…", menu: "File", group: "export", run: (a) => a.openModal("reports.sides") },
  ],
  modals: [
    { id: "reports.main", title: "Reports", width: "wide", component: ReportsModal },
    { id: "reports.sides", title: "Export Sides", width: 640, component: SidesModal },
  ],
};

export default feature;
