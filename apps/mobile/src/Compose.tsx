import { useEffect, useRef, useState, type ComponentRef } from "react";
import { Alert, AccessibilityInfo, AppState, KeyboardAvoidingView, Pressable, ScrollView, TextInput, useWindowDimensions, View } from "react-native";
import { insertCue, replaceSelection, type Cue, type Selection } from "./writing";
import type { Composition } from "./store";
import { useSpeech } from "./useSpeech";
import { Action, Bar, c, Caption, errorText, Label, NavBar, Symbol } from "./ui";

/** Write and Dictate. Notes have their own screen (Capture). */
export function Compose({ row, kind, text: initialText, keep, ended, close, send }: Composition & {
  keep(text: string): void; ended: boolean; close(): void; send(text: string, destination?: "after" | "end"): void;
}) {
  const draft = kind === "draft";
  // At accessibility text sizes four lines of attached passage fill the screen and push the editor out of view.
  const roomy = useWindowDimensions().fontScale <= 1.5;
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const [selection, setSelection] = useState<Selection>({ start: 0, end: 0 });
  const speechRange = useRef<Selection>({ start: 0, end: 0 });
  const speechSource = useRef(""), prefix = useRef("");
  function cue(kind: Cue) {
    const next = insertCue(text, selection, kind);
    setText(next.text); setSelection(next.selection); input.current?.focus();
  }
  const [text, updateText] = useState(initialText), [saveError, setSaveError] = useState("");
  function setText(value: string) {
    updateText(value);
    try { keep(value); }
    catch { setSaveError("Your iPhone couldn’t save this edit. Copy the text before leaving."); }
  }
  const textRef = useRef(text), selectionRef = useRef(selection);
  textRef.current = text; selectionRef.current = selection;
  const mic = useSpeech(() => {
    prefix.current = textRef.current.trim();
    speechSource.current = textRef.current; speechRange.current = selectionRef.current;
  }, spoken => {
    if (draft) {
      const next = replaceSelection(speechSource.current, speechRange.current, spoken);
      setText(next.text); setSelection(next.selection);
    } else setText([prefix.current, spoken].filter(Boolean).join(" "));
  });
  const { phase } = mic, error = saveError || mic.error;
  const setError = (message: string) => { setSaveError(""); mic.setError(message); };
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
  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isScreenReaderEnabled().then(enabled => { if (mounted) setVoiceOver(enabled); });
    const reader = AccessibilityInfo.addEventListener("screenReaderChanged", setVoiceOver);
    return () => { mounted = false; reader.remove(); };
  }, []);
  useEffect(() => {
    if (draft && phase === "idle" && AppState.currentState === "active") input.current?.focus();
  }, [draft, phase]);
  const deliver = (destination?: "after" | "end") => { try { send(text, destination); } catch (e) { setError(errorText(e)); } };
  // One Send that says where the text goes. Everything arrives on the Mac for the writer to accept first.
  const chooseDestination = () => Alert.alert(draft ? "Send this writing" : "Send this dictation",
    "Your Mac shows it to you before anything changes in the script.", [
      { text: draft ? "After the attached passage" : "Keep as a take to review", onPress: () => deliver() },
      { text: "After the Mac’s current scene", onPress: () => deliver("after") },
      { text: "At the end of the script", onPress: () => deliver("end") },
      { text: "Cancel", style: "cancel" },
    ]);
  return <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
    <NavBar title={draft ? "Write" : "Dictate"} leading={<Action label="Cancel" press={cancel} />}
      trailing={<Action label="Send" disabled={ended || !text.trim() || phase !== "idle"} press={chooseDestination} />} />
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 24, gap: 18, flexGrow: 1 }}>
      {ended && <Label accessibilityRole="alert">This pairing ended. Copy your text, then cancel and pair with the Mac again.</Label>}
      <View style={{ borderLeftWidth: 2, borderColor: c.accent, paddingLeft: 12 }}>
        <Caption>{row.scene ? `${row.scene} · attached passage` : "Attached passage"}</Caption><Label numberOfLines={roomy ? 4 : 2}
          style={{ fontFamily: "CourierPrime_400Regular", marginTop: 6 }}>{row.text || "Empty paragraph"}</Label>
      </View>
      <View style={{ padding: draft ? 0 : 16, gap: 8, flexGrow: draft ? 1 : 0, backgroundColor: draft ? c.page : c.group, borderRadius: 14 }}>
        <TextInput ref={input} multiline autoFocus={draft} editable={phase === "idle"}
          selection={draft ? selection : undefined}
          onSelectionChange={draft ? e => setSelection(e.nativeEvent.selection) : undefined}
          accessibilityLabel={draft ? "Draft text" : "Transcript"}
          value={text} onChangeText={setText} maxLength={20000}
          placeholder={draft ? "INT. " : "Your words appear here."}
          maxFontSizeMultiplier={draft ? 2 : undefined}
          style={{ minHeight: draft ? 240 : 124, flexGrow: draft ? 1 : 0, textAlignVertical: "top", fontSize: 18,
            fontFamily: draft ? "CourierPrime_400Regular" : undefined, color: c.ink }} />
      </View>
      {error ? <Label accessibilityRole="alert" style={{ color: c.danger }}>{error}</Label> : null}
      <View style={{ flex: 1 }} />
      {!draft && <Pressable accessibilityRole="button" accessibilityLabel={voiceOver ? phase === "listening" ? "Finish dictation" : "Start dictation" : "Dictate"}
        accessibilityHint="Hold to record. With VoiceOver, activate to start or stop."
        onPress={voiceOver ? mic.toggle : undefined}
        onPressIn={voiceOver ? undefined : () => void mic.start()} onPressOut={voiceOver ? undefined : mic.finish}
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
    {draft && <Bar><View style={{ flexDirection: "row", alignItems: "center", borderTopWidth: 0.5, borderColor: c.line, backgroundColor: c.page }}>
      <ScrollView horizontal style={{ flex: 1 }} keyboardShouldPersistTaps="always" showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ alignItems: "center", paddingHorizontal: 4 }}>
        {(["Scene", "Character", "Parenthetical", "Transition"] as const).map(name =>
          <Action key={name} label={name === "Parenthetical" ? "Paren" : name} spoken={name} disabled={phase !== "idle"} press={() => cue(name)} />)}
      </ScrollView>
      <Action label={phase === "listening" ? "Finish dictation" : "Dictate into draft"}
        icon={phase === "listening" ? "stop.fill" : "mic.fill"} iconOnly
        disabled={phase === "starting" || phase === "finishing"}
        press={mic.toggle} />
    </View></Bar>}
  </KeyboardAvoidingView>;
}
