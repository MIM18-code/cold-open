import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, FlatList, Pressable, ScrollView, TextInput, useColorScheme, View } from "react-native";
import { ELEMENT_LAYOUT, runRevision } from "@screenplay/engine";
import { revisionColor, revisionLines, type ReaderLine } from "./reader-revisions";
import { pairingEnded } from "./reach";
import { readerAnchor } from "./reader-anchor";
import type { Presence, Row } from "./live";
import { Action, c, Caption, Heading, Label, NavBar, StatusDot, Symbol, ToolbarAction } from "./ui";

type Props = {
  rows: Row[]; people: Presence; status: string; secure: boolean; showStatus(): void;
  compose(kind: "draft" | "dictation" | "note", row: Row): void;
};
export function Reader({ rows, people, status, secure, showStatus, compose }: Props) {
  const ended = pairingEnded(status);
  const dark = useColorScheme() === "dark";
  const [layouts, setLayouts] = useState<Record<string, { text: string; lines: ReaderLine[] }>>({});
  const [selected, select] = useState(""), [follow, setFollow] = useState(false);
  const [changes, setChanges] = useState(false);
  const [index, setIndex] = useState(false), [query, search] = useState("");
  const list = useRef<FlatList<Row>>(null), retry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [target, jump] = useState<string | null>(null);
  const visible = useRef<string | undefined>(undefined);
  const onVisible = useRef(({ viewableItems }: { viewableItems: { item: Row }[] }) => {
    visible.current = viewableItems[0]?.item.id;
  }).current;
  const previous = useRef<string[]>([]);
  const preferred = (follow && people.cursor) || selected || visible.current;
  if (rows.some(r => r.id === preferred)) previous.current = rows.map(r => r.id);
  const open = (kind: "draft" | "note" | "dictation") => {
    if (ended) { showStatus(); return; }
    const anchor = (follow && people.cursor) || selected || visible.current;
    const { row, changed } = readerAnchor(rows, anchor, previous.current, visible.current);
    if (!row) {
      Alert.alert("Choose a passage", "The selected passage is gone. Tap a visible paragraph before writing, dictating or adding a note.");
      return;
    }
    if (changed) Alert.alert("The selected passage was removed", `Attach to this nearby passage?\n\n${row.text.slice(0, 240)}`, [
      { text: "Cancel", style: "cancel" }, { text: "Use this passage", onPress: () => { select(row.id); compose(kind, row); } },
    ]);
    else compose(kind, row);
  };
  const [line, setLine] = useState({ id: "", y: 0 });
  const destination = follow ? people.cursor : target;
  const position = destination ? rows.findIndex(p => p.id === destination) : -1;
  useEffect(() => {
    if (!index && !changes && position >= 0) list.current?.scrollToIndex({
      index: position, viewOffset: 40 - (follow && line.id === destination ? line.y : 0), animated: false,
    });
    return () => clearTimeout(retry.current);
  }, [position, destination, index, changes, follow, line]);
  const pick = (id: string) => { setFollow(false); select(id); jump(id); setIndex(false); };
  const render = useCallback(({ item }: { item: Row }) => {
    const layout = ELEMENT_LAYOUT[item.type];
    const heading = item.type === "sceneHeading";
    const revision = people.production?.marks[item.id];
    const measured = layouts[item.id];
    const marks = revisionLines(item, measured?.text === item.text ? measured.lines : [], people.production);
    return <Pressable accessibilityRole="button"
      accessibilityLabel={`${heading ? item.scene : item.type}, ${item.text || "Empty paragraph"}${revision ? `, Revised, ${revision.label}` : ""}`}
      accessibilityHint="Tap to select. Long press to write a note."
      accessibilityState={{ selected: item.id === selected }}
      accessibilityActions={ended ? [] : [{ name: "write", label: "Write" }, { name: "note", label: "Add note" }, { name: "dictate", label: "Dictate" }]}
      onAccessibilityAction={e => {
        if (ended) return;
        if (e.nativeEvent.actionName === "write") compose("draft", item);
        else if (e.nativeEvent.actionName === "note") compose("note", item);
        else if (e.nativeEvent.actionName === "dictate") compose("dictation", item);
        else select(item.id);
      }}
      onPress={() => select(item.id)} onLongPress={ended ? undefined : () => { select(item.id); compose("note", item); }}
      style={{ paddingHorizontal: 22, paddingTop: heading ? 22 : layout.spaceBefore * 12,
        paddingBottom: 2, borderLeftWidth: 3, borderColor: item.id === selected ? c.accent : revision ? revisionColor(revision.color, dark) : "transparent" }}>
      {heading && <Label style={{ fontSize: 11, fontWeight: "700", letterSpacing: 1.4,
        color: c.sub, marginBottom: 7 }}>{item.scene.toUpperCase()}</Label>}
      <View>
      <Label key={follow && item.id === people.cursor ? people.offset : "text"} onTextLayout={e => {
        const lines = e.nativeEvent.lines.map(({ text, y, height }) => ({ text, y, height }));
        setLayouts(old => old[item.id]?.text === item.text && JSON.stringify(old[item.id]?.lines) === JSON.stringify(lines)
          ? old : { ...old, [item.id]: { text: item.text, lines } });
        if (follow && item.id === people.cursor) {
          let end = 0;
          const caret = lines.find(l => (end += l.text.length) > people.offset) ?? lines.at(-1);
          const y = caret?.y ?? 0;
          setLine(old => old.id === item.id && old.y === y ? old : { id: item.id, y });
        }
      }} style={{ fontFamily: heading ? "CourierPrime_700Bold" : "CourierPrime_400Regular", fontSize: 17,
        // The page's indents at 60%: the screenplay keeps its shape, and speeches don't wrap at 18 characters.
        marginLeft: `${Math.max(0, (layout.left - 1.5) / 6 * 60)}%`,
        marginRight: `${Math.max(0, (7.5 - layout.right) / 6 * 60)}%`, textAlign: layout.align }}>
        {item.runs.map((run, i) => <Label key={i} style={{
          fontFamily: run.bold || heading ? run.italic ? "CourierPrime_700Bold_Italic" : "CourierPrime_700Bold"
            : run.italic || layout.italic ? "CourierPrime_400Regular_Italic" : "CourierPrime_400Regular",
          textDecorationLine: run.underline ? "underline" : "none",
          color: people.production?.sets.find(s => s.id === runRevision(run))?.textColor ?? c.ink,
        }}>{layout.caps ? run.text.toUpperCase() : run.text}</Label>)}
      </Label>
      {marks.map((mark, i) => <Label key={i} accessible={false} accessibilityElementsHidden pointerEvents="none"
        style={{ position: "absolute", right: -16, top: mark.y, height: mark.height,
          fontFamily: "CourierPrime_700Bold", fontSize: 17, color: revisionColor(mark.color, dark) }}>{mark.mark}</Label>)}
      </View>
    </Pressable>;
  }, [selected, compose, ended, follow, people.cursor, people.offset, people.production, layouts, dark]);

  if (changes) return <>
    <NavBar title="Changes" leading={<Action label="Script" press={() => setChanges(false)} />} />
    <ScrollView contentContainerStyle={{ padding: 20, gap: 14 }}>
      <Heading>{people.production?.active ? `${people.production.active.name} revisions` : "Production changes"}</Heading>
      {!!people.production?.lockedPages.length && <Caption>Locked pages: {people.production.lockedPages.join(", ")}</Caption>}
      {!people.production?.scenes.length && <Caption>{people.production ? "No production changes." : "Reconnect to an updated Mac to see production changes."}</Caption>}
      {people.production?.scenes.map(scene => <Pressable key={scene.id} accessibilityRole="button"
        accessibilityLabel={`Scene ${scene.number}, ${scene.heading}, ${scene.changes.join(", ")}`}
        onPress={() => { pick(scene.id); setChanges(false); }}
        style={{ borderLeftWidth: 4, borderColor: scene.color ?? c.line, padding: 12, gap: 6 }}>
        <Caption>Scene {scene.number}</Caption><Label>{scene.heading}</Label>
        <Caption>{scene.changes.join(" · ")}</Caption>
      </Pressable>)}
    </ScrollView>
  </>;
  if (index) {
    const q = query.trim().toLocaleLowerCase();
    return <><NavBar title="Scenes" leading={<Action label="Script" icon="chevron.left" press={() => setIndex(false)} />} />
      <View style={{ paddingHorizontal: 16, paddingVertical: 10 }}>
        <TextInput accessibilityLabel="Search the script" placeholder="Search the script" clearButtonMode="while-editing"
          value={query} onChangeText={search} style={{ padding: 12, borderRadius: 12, backgroundColor: c.group,
            fontSize: 17, color: c.ink }} /></View>
      <FlatList data={rows.filter(r => q ? r.text.toLocaleLowerCase().includes(q) : r.type === "sceneHeading")}
        keyExtractor={r => r.id} ListEmptyComponent={<View style={{ padding: 20 }}><Caption>No matches.</Caption></View>}
        keyboardShouldPersistTaps="handled" renderItem={({ item }) => <Pressable accessibilityRole="button"
          onPress={() => pick(item.id)} style={{ padding: 16, marginHorizontal: 8, borderBottomWidth: 0.5, borderColor: c.line }}>
          <Caption>{item.scene}</Caption><Label numberOfLines={3}>{item.text}</Label></Pressable>} />
    </>;
  }
  return <>
    <NavBar title={people.title || "Script"}
      leading={<Action label="Scenes and search" icon="list.bullet" iconOnly press={() => { search(""); setIndex(true); }} />}
      trailing={<Action label="Status and sent items" icon="tray.full" iconOnly press={showStatus} />} />
    <FlatList ref={list} onViewableItemsChanged={onVisible} data={rows} keyExtractor={p => p.id} renderItem={render}
      contentContainerStyle={{ paddingBottom: 28 }} onScrollToIndexFailed={e => {
        list.current?.scrollToOffset({ offset: e.averageItemLength * e.index, animated: false });
        clearTimeout(retry.current);
        retry.current = setTimeout(() => list.current?.scrollToIndex({ index: Math.min(e.index, rows.length - 1),
          animated: false, viewPosition: 0.25 }), 120);
      }}
      ListHeaderComponent={<View style={{ paddingHorizontal: 22, paddingTop: 14, paddingBottom: 12,
        borderBottomWidth: 0.5, borderColor: c.line, gap: 8 }}>
        <View accessible accessibilityLabel={`${status}${secure ? "" : ", unencrypted Wi-Fi"}`}
          style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
          <StatusDot status={status} /><Caption>{status}{secure ? "" : " · Unencrypted Wi-Fi"}</Caption>
        </View>
        {ended && <Action label="Pair again" icon="link" press={showStatus} />}
        {people.writers.length > 0 && <ScrollView horizontal showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 6 }}>{people.writers.map((name, i) =>
          <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: c.group,
            borderRadius: 14, paddingHorizontal: 9, paddingVertical: 4 }}>
            <Symbol name="pencil" size={13} color={c.sub} /><Label style={{ fontSize: 13 }}>{name}</Label>
          </View>)}</ScrollView>}
      </View>} ListEmptyComponent={<View style={{ padding: 24 }}><Caption>
        {ended
          ? "Open Status to pair with your Mac again." : "Waiting for the Mac’s script."}
      </Caption></View>} />
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 8,
      borderTopWidth: 0.5, borderColor: c.line }}>
      <ToolbarAction label="Follow" icon={follow ? "location.fill" : "location"} checked={follow}
        press={() => { jump(null); setFollow(!follow); }} />
      <ToolbarAction label="Write" icon="square.and.pencil" primary disabled={ended || !rows.length} press={() => open("draft")} />
      <ToolbarAction label="Changes" icon="asterisk" press={() => setChanges(true)} />
      <ToolbarAction label="Dictate" icon="mic" disabled={ended || !rows.length} press={() => open("dictation")} />
      <ToolbarAction label="Note" icon="note.text" disabled={ended || !rows.length} press={() => open("note")} />
    </View>
  </>;
}
