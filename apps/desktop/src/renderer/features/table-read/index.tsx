import { characterEvidence, DEFAULT_READ_OPTIONS, EvidenceCache, NARRATOR, readRoles, scenesOf, type AliasSuggestion, type CastBinding, type CharacterRegistry, type ReadOptions, type Script } from "@screenplay/engine";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { CHANNELS, type OpenedFile } from "../../../shared/api.ts";
import { AI_CHANNELS, AI_SETTINGS, type AiStatus, type ProviderId } from "../../../shared/channels/ai.ts";
import { TABLE_READ, type ReadEngine, type ReaderStatus, type SynthesisResult } from "../../../shared/channels/table-read.ts";
import { app, type Feature } from "../../core/app.ts";
import { useScript, useSession, useSessionState, useSetting } from "../../core/hooks.ts";
import { desktop, messageBox } from "../../core/platform.ts";
import { AiClientError, runAi, type AiRun } from "../assistant/client.ts";
import { preferredProvider as castingProvider, providerName as castingLabel } from "../assistant/provider.ts";
import { AliasList, CastRow } from "./cast-panel.tsx";
import { accentName, assignEnsemble, castAccent, recastCharacter, subjectFromPacket, voiceInfos } from "./cast-ensemble.ts";
import { castable, castForScript, castGenders, CastingProposalError, currentCast, fillCast, mergeAiCast, requestCastProposal, voiceMap, type CastSuggestion, type ModelRequest, type ProposalContext } from "./casting.ts";
import { ignoreAlias, mergeStoredCharacters, observeCast, readStoredCast, storedCharacter, storedCharacters, writeCast, writeCastState, type StoredCast } from "./cast-store.ts";
import { browserAudio, browserAudioGroup, browserGap, ReadPlayer } from "./player.ts";
import { ReaderExtras, scopedRead, PRONUNCIATION_KEY } from "./extras.tsx";
import { ReaderPersistence, RestoreReview } from "./persistence.tsx";
import { pronounce } from "./pronunciation.ts";
import { compareTake, estimatedDuration, modeOptions, readRevision, resumeIndex, type ListeningMode, type ReadLocation } from "./workflow.ts";
import { records, resolveAnchor } from "../rewrite/records.ts";
import { VoiceDesign } from "./voice-design.tsx";
import { memoryWarning, playbackPack, VOICES_CHANGED } from "./voice-setup.ts";
import "./table-read.css";

let playback: ReadPlayer | undefined;
let currentEngine: ReadEngine = "system", currentVoices: Record<string, string> = {};
let castingRun: AiRun | undefined;
// Each casting run takes a number; cancelling or switching scripts moves it on, so a stale run cannot apply.
let castingOp = 0, castingBusy = false;
const stopCasting = () => { castingOp++; castingBusy = false; castingRun?.cancel(); castingRun = undefined; };
let currentPronunciations: unknown = [];
const evidenceCache = new EvidenceCache();
export function getReader(): ReadPlayer {
  return playback ??= new ReadPlayer({
    async synthesize(cue) {
      const voice = currentVoices[cue.speaker];
      if (!voice) throw new Error(`Choose a voice for ${cue.speaker === NARRATOR ? "the narrator" : cue.speaker}.`);
      const result = await desktop.invoke<SynthesisResult>(TABLE_READ.synthesize, { id: crypto.randomUUID(), engine: currentEngine, voice, text: pronounce(cue.text, currentPronunciations) });
      return result.audio;
    },
    audio: browserAudio,
    audioGroup: browserAudioGroup,
    gap: browserGap,
    cancel: () => desktop.invoke(TABLE_READ.cancel),
    highlight(cue) {
      const span = cue?.source?.[0];
      if (span && app.session.path) {
        localStorage.setItem(`tableRead.resume:${app.session.path}`, JSON.stringify({ paragraphId: span.paragraphId, offset: span.from }));
      }
      app.editor?.setDecorations("table-read", cue ? cue.paragraphIds.filter((id) => app.session.doc.has(id)).map((paragraphId) => ({ paragraphId, className: "table-read-speaking" })) : []);
      if (cue?.paragraphIds[0] && app.session.doc.has(cue.paragraphIds[0]) && app.setting("tableRead.follow", true)) app.editor?.revealParagraph(cue.paragraphIds[0], { select: false });
    },
  });
}
/** Evidence packets survive a rerender; one instance is enough and its fingerprints bound what is rebuilt. */
function usePlayer() { const p = getReader(); useSyncExternalStore(p.subscribe, p.snapshot); return p; }
function useStoredCast(session: ReturnType<typeof useSession>): StoredCast {
  const raw = useSyncExternalStore(
    (notify) => observeCast(session.doc, notify),
    () => JSON.stringify(readStoredCast(session.doc)),
  );
  return useMemo(() => JSON.parse(raw) as StoredCast, [raw]);
}
function subjectsFor(script: Script, registry: CharacterRegistry) {
  return registry.characters.map((identity, i) => subjectFromPacket(characterEvidence(script, identity),
    registry.characters.filter((_, j) => j !== i).flatMap((other) => [other.displayName, ...other.aliases]), identity.aliases));
}
const errorMessage = (e: unknown) => e instanceof Error ? e.message : String(e);
interface AiPick { suggestions?: CastSuggestion[]; note: string; }
function ReaderPanel() {
  const session = useSession(), script = useScript(300), sessionState = useSessionState(), player = usePlayer();
  const [chosenEngine, setEngine] = useSetting<ReadEngine | "">("tableRead.engine", "");
  const [options, setOptions] = useSetting<ReadOptions>("tableRead.options", DEFAULT_READ_OPTIONS);
  const [follow, setFollow] = useSetting("tableRead.follow", true);
  const [scope, setScope] = useState("scene");
  const [mode, setMode] = useState<ListeningMode>("range");
  const [alternative, setAlternative] = useState("");
  const effectiveOptions = modeOptions(options, mode);
  const effectiveScope = mode === "full" || mode === "dialogue" ? "all" : scope;
  const [resumeLocation, setResumeLocation] = useState<ReadLocation | null>(null);
  useEffect(() => {
    try { setResumeLocation(JSON.parse(localStorage.getItem(`tableRead.resume:${session.path}`) ?? "null")); }
    catch { setResumeLocation(null); }
  }, [session, sessionState.path, player.revision]);
  const [status, setStatus] = useState<ReaderStatus | null>(null), [error, setError] = useState("");
  const [preparing, setPreparing] = useState(false), [casting, setCasting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [aiProvider, setAiProvider] = useState<ProviderId>("ollama"), [castNote, setCastNote] = useState("");
  const [approvedCloud, setApprovedCloud] = useSetting<string[]>("tableRead.cloudCasting", []);
  const [chosenProvider] = useSetting<string>(AI_SETTINGS.provider, "ollama");
  const [query, setQuery] = useState("");
  const refresh = async () => {
    try { setStatus(await desktop.invoke<ReaderStatus>(TABLE_READ.status)); }
    catch (e) { setError(errorMessage(e)); }
  };
  useEffect(() => {
    const changed = () => { void refresh(); };
    changed(); window.addEventListener(VOICES_CHANGED, changed);
    const off = desktop.on(TABLE_READ.modelsChanged, changed);
    return () => { off(); window.removeEventListener(VOICES_CHANGED, changed); };
  }, []);
  useEffect(() => {
    void desktop.invoke<AiStatus>(AI_CHANNELS.status).then((ai) => setAiProvider(castingProvider(ai))).catch(() => undefined);
  }, [chosenProvider]);
  useEffect(() => { setError(""); setQuery(""); setCasting(false); setCastNote(""); setScope("scene"); setAlternative(""); }, [session]);
  // Until the writer picks one, use the first engine that is ready; with none ready, Phonon offers its download.
  const engine: ReadEngine = chosenEngine || (["phonon", "kokoro", "ming", "system"] as const).find((id) => status?.engines.some((e) => e.id === id && e.ready)) || "phonon";
  const selected = status?.engines.find((e) => e.id === engine);
  const stored = useStoredCast(session);
  const { state: current, registry } = useMemo(() => castForScript(script, stored), [script, stored]);
  const genders = useMemo(() => castGenders(script, registry), [script, registry]);
  const [accentChoice, setAccentChoice] = useSetting<string>("tableRead.accent", "");
  const accents = useMemo(() => [...new Set(castable(selected?.voices ?? []).map((v) => v.language.toLowerCase()).filter((l) => l.startsWith("en")))].sort(), [selected]);
  const accent = castAccent(accentChoice, accents);
  const cast = useMemo(() => fillCast(current, engine, selected?.voices ?? [], false, genders, accent), [current, engine, selected, genders, accent]);
  const roles = useMemo(() => readRoles(script, registry.characters), [script, registry]);
  const subjects = useMemo(() => subjectsFor(script, registry), [script, registry]);
  const currentVoicesByCharacter = useMemo(() => Object.fromEntries(cast.cast.map((c) => [c.id, c.voices[engine] ?? ""])), [cast, engine]);
  const names = useMemo(() => Object.fromEntries(registry.characters.map((c) => [c.id, c.displayName])), [registry]);
  const writable = !sessionState.readOnly;
  const controlsDisabled = !selected?.ready || !writable || preparing || casting;
  const canAudition = !!selected?.ready && !preparing;
  const writeCharacter = (binding: CastBinding, patch: { voices?: Record<string, string>; locked?: boolean }) => {
    try {
      const updated = patch.locked === undefined ? binding : { ...binding, locked: patch.locked };
      writeCast(session, { characters: [storedCharacter(updated, patch.voices ?? binding.voices)] });
      setError("");
    } catch (e) { setError(errorMessage(e)); }
  };
  const chooseVoice = (binding: CastBinding, voice: string) => {
    player.stop();
    writeCharacter(binding, { voices: { [engine]: voice }, locked: true });
  };
  const chooseNarrator = (voice: string) => {
    player.stop();
    try { writeCast(session, { narrator: { [engine]: voice } }); setError(""); }
    catch (e) { setError(errorMessage(e)); }
  };
  const automaticPool = () => {
    // Locked roles keep their voice inside assignEnsemble; this pool is only what automatic casting may pick.
    const pool = castable(selected?.voices ?? []), english = pool.filter((v) => v.language.startsWith("en"));
    return english.length ? english : pool;
  };
  const automaticVoices = () => voiceInfos(automaticPool(), engine);
  /** The model's picks for the open roles, or undefined when the writer chose name matching or it failed. */
  const aiCast = async (open: CastBinding[], op: number): Promise<AiPick | null> => {
    const ai = await desktop.invoke<AiStatus>(AI_CHANNELS.status);
    const provider = castingProvider(ai), label = castingLabel(provider);
    setAiProvider(provider);
    if (provider !== "ollama" && !approvedCloud.includes(provider)) {
      const answer = await messageBox({ type: "question", message: `Cast with ${label}?`,
        detail: `Each speaking character's lines and descriptions, up to a size limit, and the installed voice list go to ${label}. Script notes stay out. Speech is still generated on this Mac. You won't be asked again for ${label}.`,
        buttons: [`Cast with ${label}`, "Match by name and pronouns", "Cancel"], defaultId: 0, cancelId: 2 });
      if (answer === 2) return null;
      if (answer === 1) return { note: "" };
      setApprovedCloud([...approvedCloud, provider]);
    }
    const original = session;
    const identities = registry.characters.filter((identity) => open.some((binding) => binding.id === identity.id));
    const context: ProposalContext = { accent, cast: open, inventory: automaticPool(), packets: evidenceCache.build(original.script(), identities).packets };
    const ask = async (request: ModelRequest) => {
      if (op !== castingOp) throw new AiClientError("cancelled", "Cancelled.");
      const run = runAi({ provider, tier: "fast", json: true, maxTokens: 3000, system: request.system, messages: request.messages });
      castingRun = run;
      return run.done;
    };
    try { return { suggestions: await requestCastProposal(ask, context), note: `Cast by ${label}.` }; }
    catch (e) {
      if (e instanceof AiClientError && e.code === "cancelled") return null;
      const why = e instanceof CastingProposalError ? "its answer did not fit the cast list" : errorMessage(e);
      return { note: `${label[0]!.toUpperCase()}${label.slice(1)} could not cast (${why}). Voices were matched by name and pronouns instead.` };
    }
  };
  const assignAll = async () => {
    if (!selected || castingBusy) return;
    player.stop(); setCastNote("");
    const voices = automaticVoices();
    if (!voices.length) return;
    const original = session;
    const installedIds = new Set((selected.voices ?? []).map((v) => v.id));
    const locked = Object.fromEntries(cast.cast.filter((c) => c.locked && installedIds.has(c.voices[engine] ?? "")).map((c) => [c.id, c.voices[engine]!]));
    const input = { subjects, voices, narratorVoice: cast.narrator[engine], locked, accent };
    // The script decides gender where it can (descriptions, role words, pronouns, first names); the model is asked
    // only about the roles it leaves open.
    const open = cast.cast.filter((c) => !(c.id in locked) && !subjects.find((s) => s.id === c.id)?.gender);
    const op = ++castingOp;
    castingBusy = true; setCasting(true);
    let picked: AiPick | null;
    try {
      picked = open.length ? await aiCast(open, op).catch((e): AiPick => ({ note: `AI casting is unavailable (${errorMessage(e)}). Voices were matched by name and pronouns instead.` })) : { note: "" };
    } finally {
      if (op === castingOp) { castingBusy = false; castingRun = undefined; if (app.session === original) setCasting(false); }
    }
    if (!picked || op !== castingOp || app.session !== original) return;
    setCastNote(picked.note);
    try {
      // Write against the script and cast as they are now: an edit, an import, an alias merge or a co-writer may
      // have changed them while the model worked, and a gender the script now states outranks the model's pick.
      const now = readStoredCast(original.doc), source = original.script();
      const { state: latest, registry: latestRegistry } = castForScript(source, now);
      const fresh = { ...input, subjects: subjectsFor(source, latestRegistry) };
      const assignment = picked.suggestions ? mergeAiCast(fresh, picked.suggestions) : assignEnsemble(fresh);
      writeCast(original, {
        ...(now.narrator[engine] ? {} : { narrator: { [engine]: cast.narrator[engine] ?? "" } }),
        characters: latest.cast.filter((c) => !c.locked && assignment[c.id]).map((c) => storedCharacter(c, { [engine]: assignment[c.id]! })),
      });
      setError("");
    } catch (e) { setError(errorMessage(e)); }
  };
  const recast = (binding: CastBinding) => {
    if (!selected) return;
    player.stop();
    const next = recastCharacter({ subjects, voices: automaticVoices(), narratorVoice: cast.narrator[engine], current: currentVoicesByCharacter, accent }, binding.id);
    const voice = next[binding.id];
    if (voice) writeCharacter(binding, { voices: { [engine]: voice } });
  };
  const audition = (name: string, text: string, voice = currentVoices[name] ?? "") => {
    if (!voice) return;
    currentEngine = engine;
    currentVoices = { ...voiceMap(cast, engine), [name]: voice };
    currentPronunciations = structuredClone(session.doc.meta.get(PRONUNCIATION_KEY) ?? []);
    player.play([{ id: "audition", paragraphIds: [], source: [], sceneId: null, sceneHeading: "Voice audition", speaker: name, kind: "dialogue", text: text.slice(0, 900) }]);
  };
  const auditionCharacter = (binding: CastBinding, voice: string) => {
    audition(binding.name, roles.find((r) => r.id === binding.id)?.sample ?? "", voice);
  };
  const read = (resume = false, originalTake = false) => {
    try {
      setError(""); app.flushPending();
      const source = session.script();
      let cues = scopedRead(source, effectiveOptions, resume ? "all" : effectiveScope);
      if (mode === "compare") {
        const record = records(session.doc, "alternative").find((r) => r.id === alternative);
        const anchor = record && resolveAnchor(session.doc, record.anchor);
        if (!record || !anchor) throw new Error("Choose an attached dialogue alternative.");
        cues = compareTake(source, anchor.paragraphId, originalTake ? source.paragraphs.find((p) => p.id === anchor.paragraphId)!.runs.filter((r) => !r.note).map((r) => r.text).join("") : record.text, effectiveOptions);
      }
      if (!selected?.ready) throw new Error("Load the selected engine before starting.");
      const castSource = castForScript(source, readStoredCast(session.doc));
      const resolved = fillCast(castSource.state, engine, selected.voices, false, castGenders(source, castSource.registry), accent);
      currentEngine = engine; currentVoices = voiceMap(resolved, engine);
      currentPronunciations = structuredClone(session.doc.meta.get(PRONUNCIATION_KEY) ?? []);
      let savedLocation: ReadLocation | null = null;
      if (resume) {
        try { savedLocation = JSON.parse(localStorage.getItem(`tableRead.resume:${session.path}`) ?? "null"); }
        catch { savedLocation = null; }
      }
      const index = savedLocation ? resumeIndex(cues, savedLocation) : 0;
      if (index < 0) throw new Error("The saved passage was removed. Choose a scene to restart.");
      player.sourceRevision = readRevision(cues); player.sessionId = crypto.randomUUID();
      player.play(cues, index);
    } catch (e) { setError(errorMessage(e)); }
  };
  const openSetup = () => { player.stop(); app.openModal("workspace.settings", { section: "localFeatures" }); };
  const pack = playbackPack(status?.models ?? [], engine, status?.memoryGB);
  const prepare = async () => {
    if (engine !== "system" && !pack?.installed) { openSetup(); return; }
    const warning = pack && memoryWarning(pack, status?.memoryGB);
    if (warning && await messageBox({ type: "warning", message: "Load with less memory?", detail: warning, buttons: ["Load anyway", "Cancel"], defaultId: 1, cancelId: 1 }) !== 0) return;
    setError(""); player.stop(); setPreparing(true);
    try { setStatus(await desktop.invoke<ReaderStatus>(TABLE_READ.prepare, engine, true, warning ? pack?.id : undefined, true)); }
    catch (e) { await refresh(); setError(errorMessage(e)); }
    finally { setPreparing(false); }
  };
  const exportCast = async () => {
    const contents = JSON.stringify(cast, null, 2);
    const path = await desktop.invoke<string | null>(CHANNELS.saveDialog, { title: "Export table-read cast", defaultPath: `${session.name}.cast.json`, filters: [{ name: "Cast", extensions: ["json"] }] });
    if (path) await desktop.invoke(CHANNELS.writeFile, path, contents);
  };
  const importCast = async () => {
    const original = session;
    const files = await desktop.invoke<OpenedFile[] | null>(CHANNELS.openDialog, { title: "Import table-read cast", filters: [{ name: "Cast", extensions: ["json"] }] });
    const file = files?.[0]; if (!file || app.session !== original) return;
    if (file.data.length > 1_000_000) throw new Error("That cast file is too large.");
    const raw = JSON.parse(new TextDecoder().decode(file.data));
    if (raw?.version !== 1 || !Array.isArray(raw?.cast)) throw new Error("This is not a table-read cast file.");
    writeCastState(original, currentCast(original.script(), raw));
  };
  const mergeAlias = (suggestion: AliasSuggestion) => {
    try { mergeStoredCharacters(session, suggestion.aliasCharacterId, suggestion.characterId, storedCharacters(cast)); setError(""); }
    catch (e) { setError(errorMessage(e)); }
  };
  const differentAlias = (suggestion: AliasSuggestion) => {
    try { ignoreAlias(session, suggestion.characterId, suggestion.name); setError(""); }
    catch (e) { setError(errorMessage(e)); }
  };
  const handle = (fn: () => Promise<unknown>) => { void fn().catch((e) => setError(errorMessage(e))); };
  const visibleCast = cast.cast.filter((c) => [c.name, ...c.aliases].some((name) => name.toLowerCase().includes(query.toLowerCase())));
  const counts = new Map<string, number>(); for (const c of cast.cast) { const v = c.voices[engine]; if (v) counts.set(v, (counts.get(v) ?? 0) + 1); }
  const cue = player.cues[player.index];
  return <section className="table-reader" aria-label="Table read">
    <fieldset className="reader-primary-controls" disabled={exporting}>
    <div className="reader-heading panel-header"><h2>Table read</h2></div>
    <label className="field"><span>Voice engine</span><select aria-label="Voice engine" value={engine} disabled={preparing} onChange={(e) => { player.stop(); setEngine(e.target.value as ReadEngine); setError(""); }}>
      {(status?.engines ?? [{ id: "phonon", tier: "Quick Read", label: "Phonon 31m" }, { id: "ming", tier: "Local presets", label: "Ming 3.0" }, { id: "system", tier: "Built in", label: "Apple Premium voices" }]).map((e) => <option key={e.id} value={e.id}>{e.tier} · {e.label}</option>)}
    </select></label>
    <p className="reader-note">{selected?.note ?? "Checking local voice engines…"}</p>
    {selected && !selected.ready && <button className="button primary" disabled={!selected.available || preparing} onClick={() => void prepare()}>{preparing ? "Loading…" : pack?.installed ? "Load voice engine" : "Set up voice packs…"}</button>}
    {preparing && <button className="button" onClick={() => { player.stop(); void desktop.invoke(TABLE_READ.cancel).catch((e) => setError(errorMessage(e))); }}>Cancel loading</button>}
    <button className="button" disabled={preparing || player.active} onClick={openSetup}>Manage voice packs…</button>
    {engine === "ming" && <p className="reader-note">Free optional local tier, not a subscription. Three documented English presets in this release. Larger casts may share voices; Phonon and Kokoro have more English voices. Custom voice cloning is not included yet.</p>}
    <label className="field"><span>Mode</span><select aria-label="Listening mode" disabled={player.active} value={mode} onChange={(e) => {
      setMode(e.target.value as ListeningMode); player.setRehearsalSpeaker("");
    }}>
      <option value="full">Full script</option><option value="dialogue">Dialogue only</option>
      <option value="range">Scene or selection</option><option value="rehearsal">Rehearsal</option><option value="compare">Compare takes</option>
    </select></label>
    {mode === "compare" && <><label className="field"><span>Alternate line</span><select aria-label="Alternate line" value={alternative} onChange={(e) => setAlternative(e.target.value)}>
      <option value="">Choose an alternative</option>{records(session.doc, "alternative").map((r) => <option key={r.id} value={r.id}>{r.title || r.text.slice(0, 70)}</option>)}
    </select></label><button className="button" disabled={!selected?.ready || player.active} onClick={() => read(false, true)}>Hear original line</button><button className="button" onClick={() => app.togglePanel("rewrite", true)}>Review alternatives…</button></>}
    {resumeLocation && <button className="button" disabled={player.active || !selected?.ready} onClick={() => read(true)}>Resume saved passage</button>}
    <div className="reader-range"><label className="field"><span>Read</span><select aria-label="Reading range" disabled={player.active} value={scope} onChange={(e) => setScope(e.target.value)}><option value="scene">Current scene</option><option value="all">Whole script</option><option value="caret">From current paragraph</option><option value="selection">Selected paragraphs</option>{scenesOf(script.paragraphs).map((scene) => <option key={scene.sceneId} value={`scene:${scene.sceneId}`}>{scene.heading}</option>)}</select></label></div>
    <div className="reader-transport" role="group" aria-label="Playback">
      <button className="button" aria-label="Previous speech" disabled={!player.active || preparing} onClick={() => player.next(-1)}>‹</button>
      <button className="button primary" disabled={!selected?.ready || preparing} onClick={() => player.state === "playing" || player.state === "loading" ? player.pause() : player.state === "paused" ? player.resume() : read()}>{player.state === "paused" ? "Resume" : player.active ? "Pause" : "Play"}</button>
      <button className="button" aria-label="Next speech" disabled={!player.active || preparing} onClick={() => player.next(1)}>›</button>
      <button className="button" disabled={!player.active && !preparing} onClick={() => player.stop()}>Stop</button>
    </div>
    <div className="reader-now" role="status" aria-live="polite">
      <span>{player.state === "loading" ? "Preparing audio…" : player.state === "finished" ? "Reading finished" : player.active ? `${player.state === "paused" ? "Paused · " : ""}${cue?.speaker === NARRATOR ? "Narrator" : cue?.speaker ?? ""}` : !selected ? "" : preparing ? "Preparing voice engine…" : !selected.ready ? "Set up a voice engine to play" : "Ready when you are"}</span>
      {player.cues.length > 0 && <small>{player.index + 1} / {player.cues.length} passages</small>}
    </div>
    {player.active && <p className="reader-line">{cue?.text}</p>}
    <div className="reader-options"><label>Speed <select aria-label="Playback speed" value={player.speed} onChange={(e) => player.setRate(Number(e.target.value))}>{[0.75, 1, 1.15, 1.25, 1.5].map((n) => <option key={n} value={n}>{n}×</option>)}</select></label>
      <label>Between lines <select aria-label="Pause between speeches" value={player.gapMs} onChange={(e) => player.setGap(Number(e.target.value))}>{[0, 180, 400, 800].map((n) => <option key={n} value={n}>{n ? `${n} ms` : "No pause"}</option>)}</select></label></div>
    <label>Dual dialogue <select aria-label="Dual dialogue playback" disabled={player.active} value={player.simultaneous ? "simultaneous" : "sequential"} onChange={(e) => { player.setSimultaneous(e.target.value === "simultaneous"); }}><option value="sequential">Sequential</option><option value="simultaneous">Simultaneous</option></select></label>
    {player.cues.length > 0 && <label>Passage <select aria-label="Seek to passage" value={player.index} onChange={(e) => player.seek(Number(e.target.value))}>{player.cues.map((c, i) => <option key={c.id} value={i}>{i + 1}. {c.text.slice(0, 60)}</option>)}</select></label>}
    <p>{(() => { try { return `Table-read duration: approximately ${Math.ceil(estimatedDuration(scopedRead(script, effectiveOptions, effectiveScope), player.speed, player.gapMs) / 60)} min`; } catch { return "Table-read duration: select a range"; } })()}</p>
    <details><summary>Narration & playback</summary><div className="reader-checks">
      {([['action','Read action'],['headings','Read scene headings'],['parentheticals','Read parentheticals'],['names','Announce character names']] as const).map(([key,label]) => <label key={key}><input type="checkbox" checked={options[key]} onChange={(e) => { player.stop(); setOptions({ ...options, [key]: e.target.checked }); }}/>{label}</label>)}
      <label><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)}/>Follow the spoken passage</label>
      <p className="reader-note">Selected paragraphs are read in full. Editing leaves the captured reading playing. Apply updated text explicitly after the current speech; unchanged speech stays cached.</p>
    </div></details>
    {(error || player.error) && <div className="reader-error" role="alert">{error || player.error}<button className="button" onClick={() => { setError(""); player.stop(); void refresh(); }}>Retry setup</button></div>}
    <div className="reader-cast-head"><h3>Cast <span>{cast.cast.length}</span></h3><button className="button" disabled={controlsDisabled} onClick={() => void assignAll()}>{casting ? `Casting with ${castingLabel(aiProvider)}…` : "Assign distinct voices"}</button></div>
    {accents.length > 1 && <label className="reader-accent">Accent <select aria-label="Accent for automatic casting" value={accent ?? "any"} disabled={controlsDisabled} onChange={(e) => setAccentChoice(e.target.value)}>
      {accents.map((language) => <option key={language} value={language}>{accentName(language)}</option>)}<option value="any">Any accent</option></select></label>}
    {casting && <button className="button" onClick={() => { stopCasting(); setCasting(false); }}>Cancel casting</button>}
    <p className="reader-note">{castNote || `Gender comes from the script: descriptions, role words, pronouns and first names. Where those say nothing, ${castingLabel(aiProvider)} reads the character's scenes.${accent && accents.length > 1 ? ` Voices are ${accentName(accent)} unless the script gives a character another accent.` : ""} Locks protect your choices from recasting.`}</p>
    <AliasList suggestions={registry.suggestions} names={names} ignored={stored.ignoredAliases} disabled={!writable || preparing || casting} onMerge={mergeAlias} onDifferent={differentAlias}/>
    <div className="reader-cast-row"><strong>Narrator</strong><select aria-label="Narrator voice" value={cast.narrator[engine] ?? ""} disabled={controlsDisabled} onChange={(e) => chooseNarrator(e.target.value)}><option value="">Choose voice</option>{selected?.voices.map((v) => <option key={v.id} value={v.id}>{v.label} · {accentName(v.language)}</option>)}</select><button className="icon-button" aria-label="Audition narrator" disabled={!canAudition} onClick={() => audition(NARRATOR, "Interior. A quiet kitchen. Someone has left the back door open.")}>▶</button></div>
    {cast.cast.length > 6 && <input type="search" aria-label="Filter cast" placeholder="Find a character" value={query} onChange={(e) => setQuery(e.target.value)}/>}
    <div className="reader-cast-list">{visibleCast.map((c) => <CastRow key={c.id} binding={c} engine={engine} accent={accent} voices={selected?.voices ?? []} narratorVoice={cast.narrator[engine] ?? ""}
      subjects={subjects} current={currentVoicesByCharacter} shared={(counts.get(c.voices[engine] ?? "") ?? 0) > 1} disabled={controlsDisabled} canAudition={canAudition}
      designDisabled={!writable || preparing || player.active}
      designInstalled={!!status?.models?.some((p) => p.id === "qwen-design" && p.installed)}
      onDesign={() => { player.stop(); if (!status?.models?.some((p) => p.id === "qwen-design" && p.installed)) openSetup(); else app.openModal("tableRead.voiceDesign", { session: session.id, character: c.id, name: c.name }); }}
      onVoice={(voice) => chooseVoice(c, voice)} onLock={(locked) => writeCharacter(c, { locked })} onRecast={() => recast(c)} onAudition={(voice) => auditionCharacter(c, voice)}/>)}</div>
    {!cast.cast.length && <p className="reader-note">Character voices appear when your script contains character cues followed by dialogue.</p>}
    {sessionState.format !== "screenplay" && <ReaderPersistence key={session.id} session={session} writable={writable} />}
    {sessionState.readOnly && <p className="reader-note">Read-only: you can listen, but cast changes cannot be saved.</p>}
    <div className="reader-footer"><button className="button" onClick={() => handle(exportCast)}>Export cast…</button><button className="button" disabled={sessionState.readOnly || casting} onClick={() => handle(importCast)}>Import cast…</button></div>
    </fieldset>
    <ReaderExtras player={player} engine={engine} voices={voiceMap(cast, engine)} options={effectiveOptions} scope={effectiveScope} ready={!!selected?.ready && !preparing} onExporting={setExporting}/>
    <details><summary>Storage & privacy</summary><p className="reader-note">Speech is generated on this Mac. Model setup downloads public weights; it does not send your script. Audio cache is bounded to 256 MB and is not embedded in the screenplay. Casting uses the provider chosen in AI settings; a cloud provider asks once before its first use.</p><button className="button" disabled={player.active || preparing} onClick={() => handle(async () => { await desktop.invoke(TABLE_READ.clearCache); await refresh(); })}>Clear generated audio{status ? ` (${(status.cacheBytes / 1024 / 1024).toFixed(1)} MB)` : ""}</button></details>
  </section>;
}
function ReaderStatusItem() { const p = usePlayer(); return p.active ? <button className="reader-status-button" onClick={() => { app.setFocusMode(false); app.togglePanel("tableRead", true); }}>● Table read · {p.state}</button> : null; }
const feature: Feature = {
  id: "tableRead",
  panels: [{ id: "tableRead", title: "Listen", side: "right", order: 10, component: ReaderPanel }],
  modals: [{ id: "tableRead.voiceDesign", title: "Design a voice", width: 520, component: VoiceDesign },
    { id: "tableRead.restore", title: "Attach table-read data", width: 620, component: RestoreReview }],
  commands: [
    { id: "tableRead.open", label: "Table Read…", menu: "Tools", group: "listen", accelerator: "CmdOrCtrl+Shift+L", run: () => { app.setFocusMode(false); app.setView("script"); app.togglePanel("tableRead", true); } },
    { id: "tableRead.stop", label: "Stop Table Read", menu: "Tools", group: "listen", run: () => getReader().stop() },
    { id: "tableRead.toggle", label: "Pause / Resume Table Read", menu: "Tools", group: "listen", accelerator: "CmdOrCtrl+Shift+Space", enabled: () => getReader().active, run: () => { const p=getReader(); p.state === "paused" ? p.resume() : p.pause(); } },
  ],
  status: [{ id: "tableRead.status", order: 90, component: ReaderStatusItem }],
  activate(a) {
    let off = () => {};
    const watch = () => {
      off();
      const body = a.session.doc.body;
      const changed = () => playback?.markEdited();
      body.observe(changed); off = () => body.unobserve(changed);
    };
    window.addEventListener("beforeunload", () => playback?.close());
    navigator.mediaDevices?.addEventListener("devicechange", () => playback?.outputChanged());
    watch(); a.onSession(() => {
      playback?.replaceDocument(); stopCasting();
      evidenceCache.clear(); watch();
    });
  },
};
export default feature;
