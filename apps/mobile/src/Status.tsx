import { useState } from "react";
import { ScrollView, View, Alert } from "react-native";
import { phoneFolder } from "./folder";
import type { Pairing } from "./pairing";
import type { Take } from "./outbox";
import { pairingEnded } from "./reach";
import { unsentTakes } from "./takes-file";
import { Action, c, Caption, errorText, Label, NavBar, StatusDot, Symbol, Warning } from "./ui";

export function Status({ pair, status, takes, back, forget, sendToMac }: {
  pair: Pairing; status: string; takes: Take[]; back(): void; forget(): Promise<void>;
  sendToMac(): Promise<number>;
}) {
  const [folderChosen, setFolderChosen] = useState(() => phoneFolder.configured());
  const [folderError, setFolderError] = useState("");
  const [history, showHistory] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendNote, setSendNote] = useState(""), [sendError, setSendError] = useState("");
  const current = takes.filter(t => t.room === pair.invite.room);
  const previous = takes.filter(t => t.room !== pair.invite.room);
  const unsent = unsentTakes(pair, takes);
  const terminal = pairingEnded(status);
  async function send() {
    setSending(true); setSendNote(""); setSendError("");
    try {
      const count = await sendToMac();
      if (count) setSendNote(`Sent ${count} ${count === 1 ? "take" : "takes"} by AirDrop.`);
    } catch (e) { setSendError(errorText(e)); }
    finally { setSending(false); }
  }
  const disconnect = <Action label="Disconnect and pair again" press={() => Alert.alert("Disconnect from this Mac?",
        "Your takes stay on this iPhone. Pending takes won’t be sent to a different pairing.", [
          { text: "Cancel", style: "cancel" }, { text: "Disconnect", style: "destructive", onPress: () => {
            forget().catch(() => Alert.alert("Could not remove the pairing."));
          } },
        ])} />;
  return <><NavBar title="Status" leading={<Action label="Script" icon="chevron.left" press={back} />} />
    <ScrollView contentContainerStyle={{ padding: 20, gap: 18 }}>
      <View style={{ padding: 16, gap: 6, backgroundColor: c.group, borderRadius: 14 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Symbol name="laptopcomputer" /><Label style={{ fontWeight: "600", flex: 1 }}>{status}</Label><StatusDot status={status} />
        </View><Warning secure={pair.secure} />
        {pair.secure && status === "Reconnecting" && <Caption>This iPhone must trust the Mac’s HTTPS certificate.</Caption>}
        {pair.remembered && <Caption>Remembered until revoked on the Mac. This iPhone follows the script it was paired with.</Caption>}
        {!terminal && !pair.remembered && <Caption>Pairing ends {new Date(pair.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.</Caption>}
      </View>
      {terminal && disconnect}
      {pair.remembered && <View style={{ gap: 8 }}>
        <Action label={folderChosen ? "Change iCloud Drive folder" : "Choose iCloud Drive fallback folder"} press={() => {
          void phoneFolder.pick().then(chosen => { if (chosen) { setFolderChosen(true); setFolderError(""); } },
            e => setFolderError(errorText(e)));
        }} />
        <Caption>Choose the same folder in the Mac’s Phone panel. When live delivery fails,
          this iPhone saves pending items there. Accepted and Ignored arrive when the live link returns.</Caption>
        {folderError && <Label accessibilityRole="alert">{folderError}</Label>}
      </View>}
      {pair.remembered && !terminal && unsent.length > 0 && <View style={{ gap: 8 }}>
        <Action label={`Send to Mac (${unsent.length} remaining)`} icon="square.and.arrow.up"
          disabled={sending} press={() => void send()} />
        <Caption>AirDrop a takes file to the Mac when this iPhone and the Mac share no network.
          Takes stay pending until the Mac reports a decision.</Caption>
        {sendNote && <Label>{sendNote}</Label>}
        {sendError && <Label accessibilityRole="alert">{sendError}</Label>}
      </View>}
      <Label accessibilityRole="header" style={{ fontWeight: "700", fontSize: 22 }}>Activity</Label>
      {!current.length && <Caption>Notes and dictation will appear here after you send them.</Caption>}
      {previous.length > 0 && <Action label={history ? "Hide earlier pairings" : `Earlier pairings (${previous.length})`}
        press={() => showHistory(!history)} />}
      {(history ? [...current, ...previous] : current).map(t => <View key={t.id} style={{ paddingBottom: 14, gap: 6, borderBottomWidth: 0.5, borderColor: c.line }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
          <Label style={{ flex: 1, fontWeight: "600" }}>{t.kind.startsWith("scene-") ? "Scene suggestion" : t.kind === "note" ? "Note" : t.kind === "draft" ? "Writing" : "Dictation"}</Label>
          <Caption>{t.outcome === "saved" ? "Saved to iCloud" : t.outcome === "airdropped" ? "Sent by AirDrop" : t.outcome === "rejected" ? "Rejected" : t.outcome[0].toUpperCase() + t.outcome.slice(1)}</Caption>
        </View>
        <Label selectable>{t.text}</Label><Caption>{[t.room !== pair.invite.room ? "Earlier pairing" : "", t.scene, new Date(t.created).toLocaleTimeString([], {
          hour: "numeric", minute: "2-digit" })].filter(Boolean).join(" · ")}</Caption>
        {t.error && <Caption>{t.error}</Caption>}
        {t.outcome === "pending" && (t.room !== pair.invite.room || terminal) &&
          <Caption>This pairing has ended. Copy the text to send it with a new pairing.</Caption>}
      </View>)}
      {!terminal && disconnect}
    </ScrollView></>;
}
