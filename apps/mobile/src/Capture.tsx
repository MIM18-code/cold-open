import { useEffect, useMemo, useRef, useState, type ComponentRef } from "react";
import { AppState, KeyboardAvoidingView, PanResponder, Pressable, TextInput, View } from "react-native";
import type { Capture as Draft, Passage } from "./store";
import { useSpeech } from "./useSpeech";
import { Action, Bar, c, Caption, errorText, Label, NavBar, Symbol } from "./ui";

/** The screen Cold Open Remote opens on: type or tap the mic, and the note is kept from the first keystroke. */
export function Capture({ initial, script, ended, waiting, keep, save, reader, readerLabel }: {
  initial: Draft;
  /** The paired script's title, or null when no Mac is paired. */
  script: string | null;
  /** The pairing ended; notes wait for the next one. */
  ended?: boolean;
  /** Notes saved before pairing, waiting for a Mac. */
  waiting: number;
  keep(draft: Draft): void;
  /** Saves the note; true when it goes to the paired script now. */
  save(text: string, row: Passage | null): boolean;
  reader(): void; readerLabel: string;
}) {
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const [text, updateText] = useState(initial.text), [row, setRow] = useState(initial.row);
  const [saved, setSaved] = useState(""), [saveError, setSaveError] = useState("");
  const state = useRef({ text, row });
  state.current = { text, row };
  function update(next: Draft) {
    updateText(next.text); setRow(next.row); setSaved("");
    try { keep(next); setSaveError(""); }
    catch { setSaveError("Your iPhone couldn’t save this edit. Copy the text before leaving."); }
  }
  const prefix = useRef("");
  const mic = useSpeech(() => { prefix.current = state.current.text.trimEnd(); },
    spoken => update({ row: state.current.row, text: [prefix.current, spoken].filter(Boolean).join(prefix.current.endsWith("\n") ? "" : " ") }));
  const { phase } = mic, error = saveError || mic.error;
  function commit() {
    const { text, row } = state.current;
    if (!text.trim()) return;
    try {
      const sent = save(text, row);
      updateText(""); setRow(null); setSaveError(""); mic.setError("");
      setSaved(sent ? `Saved. It goes to Notes in “${script || "your script"}” on your Mac.`
        : "Saved on this iPhone. Pair with your Mac and it goes to that script’s Notes.");
      input.current?.focus();
    } catch (e) { setSaveError(errorText(e)); }
  }
  // Leaving the app files the note, so "open, speak, close" is the whole job.
  // Leaving mid-take stops recognition (useSpeech); the note is filed once its last words arrive.
  const latest = useRef({ phase, commit }), filePending = useRef(false);
  latest.current = { phase, commit };
  useEffect(() => {
    const watch = AppState.addEventListener("change", s => {
      if (s !== "background") return;
      if (latest.current.phase === "idle") latest.current.commit(); else filePending.current = true;
    });
    return () => watch.remove();
  }, []);
  useEffect(() => {
    if (phase === "idle" && filePending.current) { filePending.current = false; commit(); }
  }, [phase]);
  const swipe = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 24 && Math.abs(g.dx) > Math.abs(g.dy) * 2,
    onPanResponderRelease: (_, g) => { if (g.dx < -60) reader(); },
  }), [reader]);
  const listening = phase === "listening";
  return <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }} {...swipe.panHandlers}>
    <NavBar title="Note" leading={<Action label={readerLabel} icon="doc.text" press={reader} />}
      trailing={<Action label="Save" disabled={!text.trim() || phase !== "idle"} press={commit} />} />
    <View style={{ flex: 1, padding: 20, gap: 12 }}>
      <Caption>{script ? `For “${script}”` : ended ? "This pairing ended. Notes wait on this iPhone until you pair again."
        : "No Mac paired yet. Notes wait on this iPhone."}</Caption>
      {row && <View style={{ flexDirection: "row", alignItems: "center", gap: 8, borderLeftWidth: 2, borderColor: c.accent, paddingLeft: 12 }}>
        <View style={{ flex: 1 }}>
          <Caption>{row.scene ? `${row.scene} · attached passage` : "Attached passage"}</Caption>
          <Label numberOfLines={2} style={{ fontFamily: "CourierPrime_400Regular", marginTop: 4 }}>{row.text || "Empty paragraph"}</Label>
        </View>
        <Action label="Detach" press={() => update({ text, row: null })} />
      </View>}
      <TextInput ref={input} multiline autoFocus editable={phase === "idle"} accessibilityLabel="Note text"
        value={text} onChangeText={value => update({ text: value, row })} maxLength={20000}
        placeholder="Type or dictate a note…" scrollEnabled
        style={{ flex: 1, textAlignVertical: "top", fontSize: 20, color: c.ink }} />
      {saved ? <Label accessibilityRole="alert" style={{ color: c.green }}>{saved}</Label> : null}
      {error ? <Label accessibilityRole="alert" style={{ color: c.danger }}>{error}</Label> : null}
      {waiting > 0 && <Caption>{waiting === 1 ? "1 note is" : `${waiting} notes are`} waiting for your Mac.</Caption>}
    </View>
    <Bar><View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", padding: 10,
      borderTopWidth: 0.5, borderColor: c.line, backgroundColor: c.page }}>
      <Pressable accessibilityRole="button" accessibilityLabel={listening ? "Stop dictation" : "Dictate a note"}
        accessibilityHint="Tap to start, tap again to stop." disabled={phase === "starting" || phase === "finishing"}
        onPress={mic.toggle} style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 52,
          paddingHorizontal: 22, borderRadius: 26, opacity: pressed ? 0.7 : 1,
          backgroundColor: listening ? c.danger : c.accent })}>
        <Symbol name={listening ? "stop.fill" : "mic.fill"} size={22} color="white" />
        <Label numberOfLines={1} maxFontSizeMultiplier={1.35} style={{ color: "white", fontWeight: "600" }}>
          {listening ? "Stop" : phase === "starting" ? "Starting…" : phase === "finishing" ? "Finishing…" : "Dictate"}</Label>
      </Pressable>
    </View></Bar>
  </KeyboardAvoidingView>;
}
