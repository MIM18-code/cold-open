import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, StatusBar, useColorScheme, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { CourierPrime_400Regular, CourierPrime_700Bold, CourierPrime_400Regular_Italic,
  CourierPrime_700Bold_Italic, useFonts } from "@expo-google-fonts/courier-prime";
import { useRemote } from "./src/useRemote";
import { Pair } from "./src/Pair";
import { Reader } from "./src/Reader";
import { Compose } from "./src/Compose";
import { Capture } from "./src/Capture";
import { Status } from "./src/Status";
import { c } from "./src/ui";
import { resumeComposition, clearComposition, keepComposition, keepCapture, moveNoteComposition, resumeCapture, UNPAIRED,
  type Composition, type Passage } from "./src/store";
import { pairingEnded } from "./src/reach";

type Remote = ReturnType<typeof useRemote>;
export default function App() {
  const r = useRemote(), dark = useColorScheme() === "dark";
  const [fonts, fontError] = useFonts({ CourierPrime_400Regular, CourierPrime_700Bold,
    CourierPrime_400Regular_Italic, CourierPrime_700Bold_Italic });
  return <SafeAreaProvider><SafeAreaView style={{ flex: 1, backgroundColor: c.page }}>
    <StatusBar barStyle={dark ? "light-content" : "dark-content"} />
    {!r.ready || !(fonts || fontError) ? <ActivityIndicator />
      : <Workspace key={r.pair?.invite.room ?? "unpaired"} r={r} />}
  </SafeAreaView></SafeAreaProvider>;
}

/** Opens on the note screen, paired or not. The script reader is one swipe or one tap away. */
function Workspace({ r }: { r: Remote }) {
  const pair = r.pair, room = pair?.invite.room;
  const [view, setView] = useState<"note" | "script" | "status">("note");
  const [editor, edit] = useState<Composition | null>(() => {
    const resumed = room ? resumeComposition(room) : null;
    if (resumed?.kind !== "note") return resumed;
    moveNoteComposition(room!, resumed);
    return null;
  });
  const [capture, setCapture] = useState(resumeCapture);
  const note = (row?: Passage) => {
    const current = resumeCapture();
    const next = row ? { ...current, row } : current;
    if (row) keepCapture(next);
    setCapture(next); setView("note");
  };
  const waiting = r.takes.filter(t => t.room === UNPAIRED && t.kind === "note" && t.outcome === "pending").length;
  // The note screen files its own note on leaving the app. From any other screen, file the unsent note here.
  const away = useRef({ elsewhere: false, note: r.note });
  away.current = { elsewhere: pair ? view !== "note" || !!editor : view === "script", note: r.note };
  useEffect(() => {
    const watch = AppState.addEventListener("change", s => {
      if (s !== "background" || !away.current.elsewhere) return;
      const draft = resumeCapture();
      if (!draft.text.trim()) return;
      try { away.current.note(draft.text, draft.row); setCapture({ row: null, text: "" }); } catch { /* It stays on the note screen. */ }
    });
    return () => watch.remove();
  }, []);
  if (!pair) return view === "script"
    ? <Pair scan={r.scan} initialError={r.error} back={() => note()} />
    : <Capture key="unpaired" initial={capture} script={null} waiting={waiting} keep={keepCapture}
      save={r.note} reader={() => setView("script")} readerLabel="Pair" />;
  const ended = pairingEnded(r.status);
  return <>
    {view === "note" && !editor && <Capture initial={capture} script={ended ? null : r.people.title || "your script"} ended={ended}
      waiting={waiting} keep={keepCapture} save={r.note} reader={() => setView("script")} readerLabel="Script" />}
    <View style={{ flex: 1, display: view === "script" && !editor ? "flex" : "none" }}>
      <Reader rows={r.rows} people={r.people} status={r.status} secure={pair.secure}
        showStatus={() => setView("status")} note={note}
        compose={(kind, row) => edit({ kind, row, text: "" })} />
    </View>
    {editor && <Compose {...editor} ended={ended} keep={text => keepComposition(pair.invite.room, { ...editor, text })}
      close={() => { clearComposition(pair.invite.room); edit(null); }} send={(text, destination) => {
        r.submit(editor.kind, editor.row, text, destination); edit(null); setView("status");
      }} />}
    {view === "status" && !editor && <Status pair={pair} status={r.status} takes={r.takes} sendToMac={r.sendToMac}
      back={() => setView("script")} forget={async () => { await r.forget(); }} />}
  </>;
}
