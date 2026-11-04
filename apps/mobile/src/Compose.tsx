import { useEffect, useRef, useState, type ComponentRef } from "react";
import { Alert, AccessibilityInfo, AppState, KeyboardAvoidingView, Pressable, ScrollView, TextInput, View } from "react-native";
import { NativeModule, requireNativeModule } from "expo";
import { insertCue, replaceSelection, type Cue, type Selection } from "./writing";
import type { Composition } from "./store";
import { Action, c, Caption, errorText, Label, NavBar, Symbol } from "./ui";

declare class Speech extends NativeModule<{
  result: (e: { text: string }) => void; ended: (e: { error?: string }) => void;
}> {
  authorize(): Promise<boolean>; start(): Promise<void>; finish(): void; cancel(): void;
}
const speech = requireNativeModule<Speech>("InklotLocalSpeech");
export function Compose({ row, kind, text: initialText, keep, ended, close, send }: Composition & {
  keep(text: string): void; ended: boolean; close(): void; send(text: string, destination?: "after" | "end"): void;
}) {
  const note = kind === "note", draft = kind === "draft";
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const [selection, setSelection] = useState<Selection>({ start: 0, end: 0 });
  const speechRange = useRef<Selection>({ start: 0, end: 0 });
  const speechSource = useRef("");
  function cue(kind: Cue) {
    const next = insertCue(text, selection, kind);
    setText(next.text); setSelection(next.selection); input.current?.focus();
  }
  const [text, updateText] = useState(initialText), [phase, setPhase] = useState("idle"), [error, setError] = useState("");
  function setText(value: string) {
    updateText(value);
    try { keep(value); }
    catch { setError("Your iPhone couldn’t save this edit. Copy the text before leaving."); }
  }
  function cancel() {
    const discard = () => {
      try { close(); } catch { setError("Couldn’t discard this draft. Try again."); }
    };
    if (!text) { discard(); return; }
    Alert.alert("Discard this unsent text?", "You can keep writing or discard it from this iPhone.", [
      { text: "Keep writing", style: "cancel" }, { text: "Discard", style: "destructive", onPress: discard },
    ]);
  }
  const [voiceOver, setVoiceOver] = useState(false);
  const held = useRef(false), active = useRef(false), mounted = useRef(true), prefix = useRef("");
  useEffect(() => {
    mounted.current = true;
    void AccessibilityInfo.isScreenReaderEnabled().then(enabled => {
      if (mounted.current) setVoiceOver(enabled);
    });
    const reader = AccessibilityInfo.addEventListener("screenReaderChanged", setVoiceOver);
    const result = speech.addListener("result", e => {
      if (draft) {
        const next = replaceSelection(speechSource.current, speechRange.current, e.text);
        setText(next.text); setSelection(next.selection);
      } else setText([prefix.current, e.text].filter(Boolean).join(" "));
    });
    const end = speech.addListener("ended", e => {
      active.current = false; held.current = false; setPhase("idle"); if (e.error) setError(e.error);
    });
    const watch = AppState.addEventListener("change", s => {
      if (s === "background") { held.current = false; if (active.current) speech.finish(); }
    });
    return () => { mounted.current = false; held.current = false;
      reader.remove(); watch.remove(); result.remove(); end.remove(); speech.cancel(); };
  }, []);
  async function start() {
    if (held.current || active.current) return;
    held.current = true; setError(""); setPhase("starting");
    try {
      if (!(await speech.authorize())) throw new Error("Allow microphone and speech access in Settings.");
      if (!mounted.current || !held.current) return;
      prefix.current = text.trim();
      speechSource.current = text; speechRange.current = selection;
      active.current = true;
      await speech.start();
      if (!mounted.current || !held.current) { speech.finish(); return; }
      setPhase("listening");
    } catch (e) { if (mounted.current) setError(errorText(e)); active.current = false; held.current = false; }
    finally { if (mounted.current && !active.current) setPhase("idle"); }
  }
  useEffect(() => {
    if (draft && phase === "idle" && AppState.currentState === "active") input.current?.focus();
  }, [draft, phase]);
  function finish() { held.current = false; if (active.current) { setPhase("finishing"); speech.finish(); } }
  return <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
    <NavBar title={draft ? "Write" : note ? "Note" : "Dictate"} leading={<Action label="Cancel" press={cancel} />}
      trailing={<Action label={note ? "Send" : "Save as take"} disabled={ended || !text.trim() || phase !== "idle"} press={() => {
        try { send(text); } catch (e) { setError(errorText(e)); }
      }} />} />
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 24, gap: 18, flexGrow: 1 }}>
      {ended && <Label accessibilityRole="alert">This pairing ended. Copy your text, then cancel and pair with the Mac again.</Label>}
      <View style={{ borderLeftWidth: 2, borderColor: c.accent, paddingLeft: 12 }}>
        <Caption>{row.scene ? `${row.scene} · attached passage` : "Attached passage"}</Caption><Label numberOfLines={4}
          style={{ fontFamily: "CourierPrime_400Regular", marginTop: 6 }}>{row.text || "Empty paragraph"}</Label>
      </View>
      <View style={{ padding: draft ? 0 : 16, gap: 8, flexGrow: draft ? 1 : 0, backgroundColor: draft ? c.page : c.group, borderRadius: 14 }}>
        <TextInput ref={input} multiline autoFocus={draft} editable={phase === "idle"}
          selection={draft ? selection : undefined}
          onSelectionChange={draft ? e => setSelection(e.nativeEvent.selection) : undefined}
          accessibilityLabel={draft ? "Draft text" : note ? "Note text" : "Transcript"}
          value={text} onChangeText={setText} maxLength={20000}
          placeholder={draft ? "INT. " : note ? "Write a note for the Mac…" : "Your words appear here."}
          allowFontScaling={!draft}
          style={{ minHeight: draft ? 240 : 124, flexGrow: draft ? 1 : 0, textAlignVertical: "top", fontSize: 18,
            fontFamily: draft ? "CourierPrime_400Regular" : undefined, color: c.ink }} />
      </View>
      {!note && <Action label="Send to script" disabled={ended || !text.trim() || phase !== "idle"} press={() => {
        Alert.alert("Send to script", "It arrives on your Mac for you to accept.", [
          { text: "After the Mac’s current scene", onPress: () => { try { send(text, "after"); } catch (e) { setError(errorText(e)); } } },
          { text: "At the end", onPress: () => { try { send(text, "end"); } catch (e) { setError(errorText(e)); } } },
          { text: "Cancel", style: "cancel" },
        ]);
      }} />}
      {error ? <Label accessibilityRole="alert" style={{ color: c.danger }}>{error}</Label> : null}
      <View style={{ flex: 1 }} />
      {!note && !draft && <Pressable accessibilityRole="button" accessibilityLabel={voiceOver ? phase === "listening" ? "Finish dictation" : "Start dictation" : "Dictate"}
        accessibilityHint="Hold to record. With VoiceOver, activate to start or stop."
        onPress={voiceOver ? () => held.current ? finish() : void start() : undefined}
        onPressIn={voiceOver ? undefined : () => void start()} onPressOut={voiceOver ? undefined : finish}
        style={{ alignSelf: "center", alignItems: "center", gap: 10 }}>
        {({ pressed }) => <>
          <View style={{ width: 88, height: 88, borderRadius: 44, alignItems: "center", justifyContent: "center",
            backgroundColor: phase === "listening" ? c.danger : c.accent, transform: [{ scale: pressed || phase === "listening" ? 1.08 : 1 }] }}>
            <Symbol name={phase === "listening" ? "waveform" : "mic.fill"} size={34} color="white" />
          </View>
          <Label style={{ fontWeight: "600", color: phase === "listening" ? c.danger : c.ink }}>
            {phase === "listening" ? "Release to finish" : phase === "finishing" ? "Finishing…"
              : voiceOver ? "Tap to start" : "Hold to talk"}</Label>
        </>}
      </Pressable>}
    </ScrollView>
    {draft && <View style={{ flexDirection: "row", alignItems: "center", borderTopWidth: 0.5, borderColor: c.line, backgroundColor: c.page }}>
      <ScrollView horizontal style={{ flex: 1 }} keyboardShouldPersistTaps="always" showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ alignItems: "center", paddingHorizontal: 4 }}>
        {(["Scene", "Character", "Parenthetical", "Transition"] as const).map(name =>
          <Action key={name} label={name === "Parenthetical" ? "Paren" : name} disabled={phase !== "idle"} press={() => cue(name)} />)}
      </ScrollView>
      <Action label={phase === "listening" ? "Finish dictation" : "Dictate into draft"}
        icon={phase === "listening" ? "stop.fill" : "mic.fill"} iconOnly
        disabled={phase === "starting" || phase === "finishing"}
        press={() => active.current ? finish() : void start()} />
    </View>}
  </KeyboardAvoidingView>;
}
