import { useEffect, useRef, useState } from "react";
import { Alert, Image, Keyboard, KeyboardAvoidingView, Linking, ScrollView, TextInput, View, type ScrollViewInstance } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Action, c, Caption, Heading, Label, Symbol } from "./ui";
import { decodePairing } from "./pairing";

export function Pair({ scan, initialError }: { scan(raw: string): Promise<void>; initialError: string }) {
  const insets = useSafeAreaInsets();
  const scroll = useRef<ScrollViewInstance>(null), inputY = useRef(0);
  const [permission, ask] = useCameraPermissions();
  const [camera, showCamera] = useState(false), [manual, enter] = useState(false);
  const [raw, setRaw] = useState(""), [error, setError] = useState(initialError);
  const locked = useRef(false);
  useEffect(() => {
    const listener = Keyboard.addListener("keyboardDidShow", () => {
      if (manual) scroll.current?.scrollTo({ y: Math.max(0, inputY.current - 16), animated: true });
    });
    return () => listener.remove();
  }, [manual]);
  async function read(value: string) {
    if (locked.current) return;
    locked.current = true;
    try {
      const pair = decodePairing(value);
      showCamera(false);
      if (!pair.secure) {
        const ok = await new Promise<boolean>(resolve => Alert.alert("Unencrypted link",
          "People on this network could read the script, notes, and pairing key. Use only Wi-Fi you trust.", [
            { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
            { text: "Pair on this network", onPress: () => resolve(true) },
          ]));
        if (!ok) return;
      }
      await scan(value);
    } catch (e) { setError(e instanceof SyntaxError || e instanceof TypeError ? "Use the QR code or Copy app pairing code in the Mac’s Phone Companion." : e instanceof Error ? e.message : "Couldn’t pair. Start pairing again on the Mac."); }
    finally { locked.current = false; }
  }
  async function start() {
    setError("");
    if (!permission?.granted && !(await ask()).granted) {
      setError("Allow Camera in Settings, or paste the pairing code."); return;
    }
    showCamera(true);
  }
  return <KeyboardAvoidingView behavior="padding" keyboardVerticalOffset={insets.top} style={{ flex: 1 }}>
    <ScrollView ref={scroll} style={{ flex: 1 }} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive"
      contentContainerStyle={{ flexGrow: 1, padding: 24, paddingBottom: 32, gap: 16 }}>
      {!manual && <Image source={require("../assets/mark.png")} style={{ height: 66, width: 66, marginLeft: -7 }} />}
      <View><Heading>Pair with your Mac</Heading>
        <Label style={{ color: c.sub }}>{manual
          ? "On the Mac, choose Copy app pairing code. Paste that code here, then tap Pair."
          : "On your Mac, open your script in Cold Open. Choose Tools → Phone Companion, then Start phone pairing. Scan the QR code shown on the Mac."}</Label>
      </View>
      {!manual && <><View style={{ backgroundColor: c.group, minHeight: 220, justifyContent: "center", alignItems: "center",
        padding: camera ? 0 : 24, borderRadius: 18, overflow: "hidden", gap: 16 }}>
        {camera ? <CameraView style={{ width: "100%", height: 260 }} barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={e => void read(e.data)} /> : <>
          <Symbol name="qrcode.viewfinder" size={76} />
          <Label style={{ fontWeight: "600" }}>Scan the code on your Mac</Label>
        </>}
      </View>
      </>}
      {error ? <Label accessibilityRole="alert" style={{ color: c.danger }}>{error}</Label> : null}
      {manual && <View onLayout={e => { inputY.current = e.nativeEvent.layout.y; }}><TextInput accessibilityLabel="Private pairing code" value={raw} onChangeText={value => { setRaw(value); setError(""); }}
        autoFocus autoCapitalize="none" autoCorrect={false} autoComplete="off" textContentType="none"
        keyboardType="default" dataDetectorTypes="none" returnKeyType="join" submitBehavior="blurAndSubmit"
        onSubmitEditing={e => void read(e.nativeEvent.text)} secureTextEntry placeholder="Paste pairing code"
        style={{ fontSize: 17, backgroundColor: c.group, color: c.ink, borderRadius: 10, padding: 12 }} /></View>}
      <Action primary icon={manual ? "link" : "camera"} label={manual ? "Pair" : camera ? "Close camera" : "Scan code"}
        press={() => manual ? void read(raw) : camera ? showCamera(false) : void start()} />
      <Action label={manual ? "Use camera instead" : "Paste a pairing code"} press={() => { enter(!manual); showCamera(false); setError(""); }} />
      {!manual && <>
      <Caption>For your own phone, select Remember this iPhone on the Mac before you start pairing.</Caption>
      <View style={{ gap: 6 }}>
        <Label accessibilityRole="header" style={{ fontWeight: "700" }}>Away from home?</Label>
        <Caption>1. Install Tailscale from the App Store, then sign in with the same account as your Mac.</Caption>
        <Caption>2. Choose Tailscale in Phone Companion on the Mac. Scan its QR code, or paste its app pairing code here.</Caption>
        <Action label="Get Tailscale" icon="arrow.up.forward.app"
          press={() => void Linking.openURL("https://apps.apple.com/app/tailscale/id1470499037")} />
      </View>
      </>}
    </ScrollView>
  </KeyboardAvoidingView>;
}
