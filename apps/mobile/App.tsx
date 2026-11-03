import { useState } from "react";
import { ActivityIndicator, StatusBar, useColorScheme, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { CourierPrime_400Regular, CourierPrime_700Bold, CourierPrime_400Regular_Italic,
  CourierPrime_700Bold_Italic, useFonts } from "@expo-google-fonts/courier-prime";
import { useRemote } from "./src/useRemote";
import { Pair } from "./src/Pair";
import { Reader } from "./src/Reader";
import { Compose } from "./src/Compose";
import { Status } from "./src/Status";
import { c } from "./src/ui";
import { resumeComposition, clearComposition, keepComposition, type Composition } from "./src/store";
import { pairingEnded } from "./src/reach";

export default function App() {
  const r = useRemote(), dark = useColorScheme() === "dark";
  const [fonts, fontError] = useFonts({ CourierPrime_400Regular, CourierPrime_700Bold,
    CourierPrime_400Regular_Italic, CourierPrime_700Bold_Italic });
  return <SafeAreaProvider><SafeAreaView style={{ flex: 1, backgroundColor: c.page }}>
    <StatusBar barStyle={dark ? "light-content" : "dark-content"} />
    {!r.ready || !(fonts || fontError) ? <ActivityIndicator /> : !r.pair ? <Pair scan={r.scan} initialError={r.error} /> : <Workspace key={r.pair.invite.room} r={r} pair={r.pair} />}
  </SafeAreaView></SafeAreaProvider>;
}

function Workspace({ r, pair }: { r: ReturnType<typeof useRemote>; pair: NonNullable<ReturnType<typeof useRemote>["pair"]> }) {
  const room = pair.invite.room;
  const [activity, showActivity] = useState(false);
  const [editor, edit] = useState<Composition | null>(() => resumeComposition(room));
  return <>
      <View style={{ flex: 1, display: activity || editor ? "none" : "flex" }}>
        <Reader rows={r.rows} people={r.people} status={r.status} secure={pair.secure}
          showStatus={() => showActivity(true)} compose={(kind, row) => edit({ kind, row, text: "" })} />
      </View>
      {editor && <Compose {...editor} ended={pairingEnded(r.status)} keep={text => keepComposition(room, { ...editor, text })}
        close={() => { clearComposition(room); edit(null); }} send={(text, destination) => {
        r.submit(editor.kind, editor.row, text, destination); edit(null); showActivity(true);
      }} />}
      {activity && !editor && <Status pair={pair} status={r.status} takes={r.takes} sendToMac={r.sendToMac}
        back={() => showActivity(false)} forget={async () => { await r.forget(); showActivity(false); }} />}
    </>;
}
