import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { resolve } from "node:path";

// Exercise native component props and handlers without a Simulator or a JS renderer dependency.
const result = await build({ stdin: { contents: `export { Pair } from "./src/Pair";
  export { Reader } from "./src/Reader"; export { Capture } from "./src/Capture"; export { begin, reset } from "react";
  export { opened, keyboard, appState } from "react-native"; export { speech } from "expo";`, resolveDir: resolve(import.meta.dirname, "..") },
  bundle: true, write: false, platform: "node", format: "esm", jsx: "automatic",
  plugins: [{ name: "native-controls", setup(b) {
    b.onResolve({ filter: /^(react|react\/jsx-runtime|react-native|expo|expo-camera|expo-symbols|react-native-safe-area-context)$/ }, args =>
      ({ path: args.path, namespace: "controls" }));
    b.onResolve({ filter: /\.png$/ }, () => ({ path: "image", namespace: "controls" }));
    b.onLoad({ filter: /.*/, namespace: "controls" }, ({ path }) => ({ contents: path === "react" ? `
      let slots = [], cursor = 0;
      export function begin() { cursor = 0; }
      export function reset() { slots = []; begin(); }
      export function useState(value) { const i = cursor++; if (!(i in slots)) slots[i] = value;
        return [slots[i], next => { slots[i] = typeof next === "function" ? next(slots[i]) : next; }]; }
      export function useRef(value) { return useState({ current: value })[0]; }
      export function useEffect(fn) { fn(); }
      export function useCallback(fn) { return fn; }
      export function useMemo(fn) { return fn(); }
      export function createContext(value) { return { Provider: "Provider", value }; }
      export function useContext(context) { return context.value; }
    ` : path === "react/jsx-runtime" ? `export const Fragment = "Fragment";
      export function jsx(type, props) { return { type, props }; } export const jsxs = jsx;`
      : path === "react-native" ? `
      export const View = "View", Text = "Text", Pressable = "Pressable", Image = "Image", TextInput = "TextInput",
        ScrollView = "ScrollView", FlatList = "FlatList", KeyboardAvoidingView = "KeyboardAvoidingView";
      export const opened = [], keyboard = {}, appState = [];
      export const AppState = { currentState: "active", addEventListener(name, fn) { appState.push(fn); return { remove() {
        appState.splice(appState.indexOf(fn), 1); } }; } };
      export const PanResponder = { create(config) { return { panHandlers: {}, config }; } };
      export const Linking = { openURL(url) { opened.push(url); } };
      export const Keyboard = { addListener(name, fn) { keyboard[name] = fn; return { remove() {} }; } };
      export const Alert = { alert() { throw Error("Unexpected alert"); } };
      export const PlatformColor = name => name;
      export const useColorScheme = () => "dark";
    ` : path === "expo" ? `
      const listeners = { result: [], ended: [] };
      export const speech = { started: 0, finished: 0, listeners, async authorize() { return true; },
        async start() { this.started++; }, finish() { this.finished++; }, cancel() {},
        addListener(name, fn) { listeners[name].push(fn); return { remove() { listeners[name].splice(listeners[name].indexOf(fn), 1); } }; } };
      export class NativeModule {}
      export const requireNativeModule = () => speech;
    ` : path === "expo-camera" ? `export const CameraView = "CameraView";
      export const useCameraPermissions = () => [{ granted: true }, async () => ({ granted: true })];`
      : path === "expo-symbols" ? `export const SymbolView = "SymbolView";`
      : path === "image" ? `export default {};`
      : `export const useSafeAreaInsets = () => ({ top: 20, bottom: 0 });` }));
  } }],
});
const ui = await import("data:text/javascript;base64," + Buffer.from(result.outputFiles[0]!.text).toString("base64"));
type Node = { type: string | ((props: any) => Node); props: Record<string, any> };
function nodes(value: any): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object") return [];
  if (typeof value.type === "function") return nodes(value.type(value.props));
  return [value, ...nodes(value.props.children)];
}
function render(component: (props: any) => Node, props: any) { ui.begin(); return nodes(component(props)); }
const button = (tree: Node[], label: string) => tree.find(n => n.type === "Pressable" && n.props.accessibilityLabel === label)!;

test("pairing Return submits the code like Pair, never opening a URL, and keyboard reveal scrolls to the field", async () => {
  ui.reset();
  const scanned: string[] = [];
  const props = { scan: async (raw: string) => { scanned.push(raw); }, initialError: "" };
  let tree = render(ui.Pair, props);
  const scroll = tree.find(n => n.type === "ScrollView")!;
  let scrolled = -1;
  scroll.props.ref.current = { scrollTo: ({ y }: { y: number }) => { scrolled = y; } };
  assert.equal(scroll.props.style.flex, 1);
  assert.ok(scroll.props.contentContainerStyle.paddingBottom >= 24);
  button(tree, "Paste a pairing code").props.onPress();
  tree = render(ui.Pair, props);
  let field = tree.find(n => n.type === "TextInput")!;
  const code = JSON.stringify({ v: 1, url: "https://127.0.0.1:4455/#" + "t".repeat(43), expiresAt: Date.now() + 3600000,
    invite: "screenplay://join?relay=wss%3A%2F%2F127.0.0.1%3A4455&room=" + "r".repeat(22) + "&key=" + "k".repeat(22) + "&access=read" });
  field.props.onChangeText(code);
  tree = render(ui.Pair, props);
  field = tree.find(n => n.type === "TextInput")!;
  assert.equal(field.props.submitBehavior, "blurAndSubmit");
  assert.equal(field.props.dataDetectorTypes, "none");
  tree.find(n => n.type === "View" && n.props.onLayout)!.props.onLayout({ nativeEvent: { layout: { y: 120 } } });
  ui.keyboard.keyboardDidShow();
  assert.equal(scrolled, 104);
  // Return carries the field's final text; React state can lag the last keystroke, so a stale render must not matter.
  const stale = render(ui.Pair, props).find(n => n.type === "TextInput")!;
  stale.props.onSubmitEditing({ nativeEvent: { text: code } });
  await new Promise(resolve => setImmediate(resolve));
  button(tree, "Pair").props.onPress();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(scanned, [code, code]);
  assert.deepEqual(ui.opened, []);
  field.props.onChangeText("screenplay://invalid");
  tree = render(ui.Pair, props);
  tree.find(n => n.type === "TextInput")!.props.onSubmitEditing({ nativeEvent: { text: "screenplay://invalid" } });
  assert.deepEqual(ui.opened, []);
  assert.ok(render(ui.Pair, props).some(n => n.props.accessibilityRole === "alert"));
});

test("reader toolbar has five equal slots, Write is primary, revisions are accessible and Changes names the set", () => {
  ui.reset();
  const row = { id: "p", type: "action", runs: [{ text: "Revised", fdx: { RevisionID: "1" } }], text: "Revised", scene: "Scene 1" };
  const set = { id: "1", name: "Blue", mark: "+", color: "#0000ff", date: "", style: "" };
  const props = { rows: [row], people: { title: "Script", writers: [], cursor: null, offset: 0,
    production: { v: 2, active: set, sets: [set], scenes: [], lockedPages: [], marks: { p: { label: "Blue", color: set.color } } } },
    status: "Live", secure: true, showStatus() {}, compose() {} };
  let tree = render(ui.Reader, props);
  const toolbar = ["Follow", "Write", "Changes", "Dictate", "Note"].map(label => button(tree, label));
  assert.ok(toolbar.every(n => n.props.style({ pressed: false }).flex === 1));
  assert.ok(toolbar.every(n => n.props.style({ pressed: false }).minWidth === 0));
  assert.equal(toolbar[1]!.props.style({ pressed: false }).backgroundColor, "systemBlue");
  assert.equal(toolbar[0]!.props.accessibilityRole, "switch");
  const list = tree.find(n => n.type === "FlatList")!;
  let paragraph = nodes(list.props.renderItem({ item: row }));
  assert.match(paragraph[0]!.props.accessibilityLabel, /Revised, Blue/);
  assert.equal(paragraph.find(n => n.type === "Text" && n.props.children === "Revised")!.props.style[1].textDecorationLine, "none");
  paragraph.find(n => n.type === "Text" && n.props.onTextLayout)!.props.onTextLayout({ nativeEvent: { lines: [{ text: "Revised", y: 0, height: 20 }] } });
  tree = render(ui.Reader, props);
  paragraph = nodes(tree.find(n => n.type === "FlatList")!.props.renderItem({ item: row }));
  const mark = paragraph.find(n => n.type === "Text" && n.props.children === "+")!;
  assert.equal(mark.props.style[1].position, "absolute");
  assert.equal(mark.props.accessibilityElementsHidden, true);
  button(tree, "Changes").props.onPress();
  assert.ok(render(ui.Reader, props).some(n => n.type === "Text" && n.props.children === "Blue revisions"));
});

test("reader reuses unrevised line measurements when revision metadata arrives without another layout", () => {
  ui.reset();
  const row = { id: "p", type: "action", runs: [{ text: "Original. Revised." }], text: "Original. Revised.", scene: "Scene 1" };
  const props = { rows: [row], people: { title: "Script", writers: [], cursor: null, offset: 0 },
    status: "Live", secure: true, showStatus() {}, compose() {} };
  const paragraph = (value: typeof props) => {
    const tree = render(ui.Reader, value);
    return nodes(tree.find(n => n.type === "FlatList")!.props.renderItem({ item: value.rows[0] }));
  };
  paragraph(props).find(n => n.type === "Text" && n.props.onTextLayout)!.props.onTextLayout({ nativeEvent: {
    lines: [{ text: "Original. ", y: 0, height: 20 }, { text: "Revised.", y: 20, height: 20 }],
  } });
  assert.equal(paragraph(props).some(n => n.props.accessibilityElementsHidden), false);
  const set = { id: "1", name: "Blue", mark: "+", color: "#0000ff", date: "", style: "" };
  const revised = { ...props, rows: [{ ...row, runs: [{ text: "Original. " }, { text: "Revised.", fdx: { RevisionID: "1" } }] }],
    people: { ...props.people, production: { v: 2, active: set, sets: [set], scenes: [], lockedPages: [],
      marks: { p: { label: "Blue", color: set.color } } } } };
  const marks = paragraph(revised).filter(n => n.props.accessibilityElementsHidden);
  assert.equal(marks.length, 1);
  assert.equal(marks[0]!.props.children, "+");
  assert.equal(marks[0]!.props.style[1].top, 20);
  assert.equal(paragraph({ ...revised, rows: [{ ...revised.rows[0], text: "Changed text" }] })
    .some(n => n.props.accessibilityElementsHidden), false);
});

test("an ended pairing lets a writer read cached pages, keep taking notes, and pair again without writing into a dead inbox", () => {
  for (const status of ["Pairing expired", "This Mac revoked the pairing", "Host stopped sharing", "Refused"]) {
    ui.reset();
    const row = { id: "p", type: "action", runs: [{ text: "Cached." }], text: "Cached.", scene: "Scene 1" };
    let statusOpened = false;
    const notes: unknown[] = [];
    const tree = render(ui.Reader, { rows: [row], people: { title: "Script", writers: [], cursor: null, offset: 0 },
      status, secure: true, showStatus() { statusOpened = true; }, compose() { assert.fail("Pairing ended"); },
      note(passage?: unknown) { notes.push(passage); } });
    for (const action of ["Write", "Dictate"]) assert.equal(button(tree, action).props.disabled, true);
    // Notes still work: they wait on the iPhone for the next pairing.
    assert.equal(button(tree, "Note").props.disabled, undefined);
    button(tree, "Note").props.onPress();
    assert.deepEqual(notes, [undefined], "no passage was selected, so the note is loose");
    const list = tree.find(n => n.type === "FlatList")!;
    const passage = list.props.renderItem({ item: row });
    passage.props.onLongPress();
    assert.equal(notes.at(-1), row);
    assert.deepEqual(passage.props.accessibilityActions, [{ name: "note", label: "Add note" }]);
    button(nodes(list.props.ListHeaderComponent), "Pair again").props.onPress();
    assert.ok(statusOpened);
  }
});

test("the note screen keeps every keystroke, saves without a passage, saves on leaving, and dictates with one tap", async () => {
  ui.reset();
  const kept: { text: string; row: unknown }[] = [], saved: { text: string; row: unknown }[] = [];
  let opened = 0;
  const props = { initial: { row: null, text: "" }, script: "The Last Crossing", waiting: 2,
    keep(d: { text: string; row: unknown }) { kept.push(d); },
    save(text: string, row: unknown) { saved.push({ text, row }); return true; }, reader() { opened++; }, readerLabel: "Script" };
  let tree = render(ui.Capture, props);
  const input = () => tree.find(n => n.type === "TextInput")!;
  assert.equal(input().props.autoFocus, true, "the keyboard is up on open");
  assert.ok(tree.some(n => n.type === "Text" && n.props.children === "For “The Last Crossing”"));
  assert.ok(tree.some(n => n.type === "Text" && Array.isArray(n.props.children) && n.props.children.join("") === "2 notes are waiting for your Mac."));
  assert.equal(button(tree, "Save").props.disabled, true);
  input().props.onChangeText("Eli should sound tired");
  assert.deepEqual(kept.at(-1), { text: "Eli should sound tired", row: null }, "kept on the first keystroke");
  tree = render(ui.Capture, props);
  button(tree, "Save").props.onPress();
  assert.deepEqual(saved, [{ text: "Eli should sound tired", row: null }]);
  tree = render(ui.Capture, props);
  assert.equal(input().props.value, "");
  assert.ok(tree.some(n => n.props.accessibilityRole === "alert" && /Notes in “The Last Crossing”/.test(n.props.children)));

  input().props.onChangeText("Lamp on the water");
  tree = render(ui.Capture, props);
  for (const fn of [...ui.appState]) fn("background");
  assert.deepEqual(saved.at(-1), { text: "Lamp on the water", row: null }, "leaving the app files the note");

  tree = render(ui.Capture, props);
  input().props.onChangeText("Open on");
  tree = render(ui.Capture, props);
  button(tree, "Dictate a note").props.onPress();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(ui.speech.started, 1);
  for (const fn of ui.speech.listeners.result) fn({ text: "the ferry at dawn" });
  tree = render(ui.Capture, props);
  assert.equal(input().props.value, "Open on the ferry at dawn");
  button(tree, "Stop dictation").props.onPress();
  assert.equal(ui.speech.finished, 1);
  for (const fn of ui.speech.listeners.ended) fn({ error: "Failed to initialize recognizer" });
  tree = render(ui.Capture, props);
  assert.ok(tree.some(n => n.props.accessibilityRole === "alert" && /^Dictation stopped\. Check that Dictation is on/.test(n.props.children)));

  const pan = tree.find(n => n.type === "KeyboardAvoidingView")!;
  assert.ok(pan);
  button(tree, "Script").props.onPress();
  assert.equal(opened, 1);
});

test("an attached passage shows on the note screen and Detach makes the note loose", () => {
  ui.reset();
  const row = { id: "p", scene: "Scene 1", text: "NORA sets a thermos on the counter." };
  const saved: unknown[] = [];
  const props = { initial: { row, text: "Two cups" }, script: null, waiting: 0, keep() {},
    save(_: string, r: unknown) { saved.push(r); return false; }, reader() {}, readerLabel: "Pair" };
  let tree = render(ui.Capture, props);
  assert.ok(tree.some(n => n.type === "Text" && n.props.children === "No Mac paired yet. Notes wait on this iPhone."));
  assert.ok(tree.some(n => n.type === "Text" && n.props.children === "Scene 1 · attached passage"));
  button(tree, "Detach").props.onPress();
  tree = render(ui.Capture, props);
  assert.ok(!tree.some(n => n.type === "Text" && n.props.children === "Scene 1 · attached passage"));
  button(tree, "Save").props.onPress();
  assert.deepEqual(saved, [null]);
  tree = render(ui.Capture, props);
  assert.ok(tree.some(n => n.props.accessibilityRole === "alert" && /Pair with your Mac/.test(n.props.children)));
});

test("leaving the app mid-dictation files the note once the last words arrive", async () => {
  ui.reset();
  ui.appState.length = 0;
  const saved: string[] = [];
  const props = { initial: { row: null, text: "" }, script: "Ferry", waiting: 0, keep() {},
    save(text: string) { saved.push(text); return true; }, reader() {}, readerLabel: "Script" };
  let tree = render(ui.Capture, props);
  button(tree, "Dictate a note").props.onPress();
  await new Promise(r => setTimeout(r, 0));
  tree = render(ui.Capture, props);
  for (const fn of ui.speech.listeners.result) fn({ text: "the lamp on the" });
  tree = render(ui.Capture, props);
  for (const fn of [...new Set(ui.appState)]) fn("background");
  assert.deepEqual(saved, [], "nothing is filed while the take is still being transcribed");
  for (const fn of ui.speech.listeners.result) fn({ text: "the lamp on the water" });
  for (const fn of ui.speech.listeners.ended) fn({ error: "" });
  render(ui.Capture, props);
  assert.deepEqual(saved, ["the lamp on the water"]);
});
