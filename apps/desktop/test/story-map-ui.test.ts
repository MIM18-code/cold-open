import assert from "node:assert/strict";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import * as engine from "@screenplay/engine";

import { DocumentSession } from "../src/renderer/core/session.ts";
import { structureOf } from "../src/renderer/features/navigator/structure-model.ts";

type Component = (props: any) => Element;
interface Element {
  type: string | Component;
  props: Record<string, any>;
}

let javascript: string;
before(async () => {
  const mocks: Record<string, string> = {
    react: `
      export const useState = (value) => globalThis.hooks.useState(value);
      export const useRef = (value) => useState(() => ({ current: value }))[0];
      export const useMemo = (fn) => fn();
      export const useCallback = (fn) => fn;
      export const useEffect = () => {};
      export const useLayoutEffect = () => {};
      export const memo = (fn) => fn;
    `,
    "react/jsx-runtime": `export const jsx = (type, props) => ({ type, props }); export const jsxs = jsx; export const Fragment = "fragment";`,
    "app.ts": "export const app = globalThis.fixture.app;",
    "hooks.ts": `
      export const useSession = () => globalThis.fixture.session;
      export const useSessionState = useSession;
      export const useDocVersion = () => globalThis.fixture.session.version;
    `,
    "structure-data.ts": `
      export const useStructure = () => globalThis.fixture.structure();
      export const useCaretScene = () => null;
      export const revealScene = () => {};
    `,
    "shared.tsx": "export const EditableText = () => null; export const ReadOnlyNotice = () => null;",
  };
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../src/renderer/features/story-map/index.tsx", import.meta.url))],
    bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic",
    packages: "external", loader: { ".css": "empty" },
    plugins: [{ name: "component-hooks", setup(plugin) {
      plugin.onResolve({ filter: /^react(?:\/jsx-runtime)?$|\/core\/(hooks|app)\.ts$|\/navigator\/(structure-data\.ts|shared\.tsx)$/ }, (args) => ({
        path: args.path.startsWith("react") ? args.path : args.path.split("/").at(-1)!, namespace: "mock",
      }));
      plugin.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({ contents: mocks[args.path]! }));
    } }],
  });
  javascript = result.outputFiles[0]!.text;
});

function fixture() {
  const doc = new engine.ScreenplayDoc();
  doc.load({ titlePage: [], paragraphs: [1, 2, 3, 4].map((n) => ({
    id: `s${n}`, sceneId: `s${n}`, type: "sceneHeading", startsNewPage: true,
    runs: [{ text: `INT. ROOM ${n} - DAY` }],
  })) });
  const point = engine.addStructurePoint(doc, { name: "Midpoint", position: 0.5, sceneId: "s3" });
  const session = new DocumentSession(doc);
  const fixture = {
    session,
    app: { session, toast() {} },
    structure: () => structureOf(session.script(), engine.paginate(session.script(), { locks: engine.pageLocks(doc) ?? undefined })),
  };
  let cursor = 0;
  let slots: unknown[] = [];
  const componentSlots = new Map<Component, unknown[]>();
  const module = { exports: {} as { default: { views: [{ component: Component }] } } };
  runInNewContext(javascript, {
    module, exports: module.exports, fixture,
    hooks: { useState(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], (value: unknown) => { slots[index] = value; }];
    } },
    require: (name: string) => {
      assert.equal(name, "@screenplay/engine");
      return engine;
    },
  });
  const render = (component: Component, props = {}) => {
    cursor = 0;
    if (!componentSlots.has(component)) componentSlots.set(component, []);
    slots = componentSlots.get(component)!;
    return component(props);
  };
  const view = () => render(module.exports.default.views[0].component);
  return { doc, point, session, render, view };
}

function elements(root: unknown): Element[] {
  if (Array.isArray(root)) return root.flatMap(elements);
  if (!root || typeof root !== "object" || !("props" in root)) return [];
  const element = root as Element;
  return [element, ...elements(element.props.children)];
}
function find(root: unknown, predicate: (element: Element) => boolean): Element {
  const element = elements(root).find(predicate);
  assert(element, "expected component control");
  return element;
}
const row = (f: ReturnType<typeof fixture>) => {
  const element = find(f.view(), (e) => typeof e.type === "function" && e.type.name === "PointRow");
  return f.render(element.type as Component, element.props);
};

test("a completed drag has its own undo entry before an immediate unpin", () => {
  const f = fixture();
  const label = find(f.view(), (e) => e.props.className === "story-map-marker-label");
  const pointer = { button: 0, clientX: 100, pointerId: 1, preventDefault() {},
    currentTarget: { setPointerCapture() {}, hasPointerCapture: () => false } };
  label.props.onPointerDown(pointer);
  label.props.onPointerMove({ ...pointer, clientX: 116 });
  label.props.onPointerUp(pointer);
  const moved = engine.structurePoints(f.doc)[0]!;
  assert.equal(moved.position, 0.75);
  find(row(f), (e) => e.type === "select").props.onChange({ target: { value: "" } });
  assert.equal(engine.structurePoints(f.doc)[0]!.sceneId, undefined);
  f.session.undo.undo();
  assert.deepEqual(engine.structurePoints(f.doc), [moved]);
  f.session.undo.undo();
  assert.deepEqual(engine.structurePoints(f.doc), [f.point]);
  f.session.undo.redo();
  assert.deepEqual(engine.structurePoints(f.doc), [moved]);
});

test("connector endpoints and dot use the same page scale as scene blocks", () => {
  const f = fixture();
  for (const zoom of [null, "Zoom in", "Zoom out"]) {
    if (zoom) find(f.view(), (e) => e.props["aria-label"] === zoom).props.onClick();
    const view = f.view();
    const track = find(view, (e) => typeof e.type === "function" && e.props.pixelsPerPage !== undefined);
    const blocks = f.render(track.type as Component, track.props);
    const scene = find(blocks, (e) => e.props["data-scene-id"] === "s3");
    const marker = find(view, (e) => e.props["data-point-id"] === f.point.id);
    const dot = find(view, (e) => e.props.className === "story-map-actual-dot");
    const connector = find(view, (e) => e.props.className === "story-map-connector");
    const actual = parseFloat(scene.props.style.left);
    const target = parseFloat(marker.props.style.left);
    assert.equal(target + parseFloat(dot.props.style.left), actual);
    assert.equal(target + parseFloat(connector.props.style.left), Math.min(target, actual));
    assert.equal(parseFloat(connector.props.style.width), Math.abs(actual - target));
  }
});

test("a deleted scene's stored pin stays selected and can be cleared without any scenes", () => {
  const f = fixture();
  f.session.edit(() => { for (const paragraph of [...f.doc.paragraphs()]) f.doc.deleteParagraph(paragraph.id); });
  const select = find(row(f), (e) => e.type === "select");
  assert.equal(select.props.value, "s3");
  select.props.onChange({ target: { value: "" } });
  assert.equal(engine.structurePoints(f.doc)[0]!.sceneId, undefined);
});


test("printed A-page labels reach the ruler, scene references and editable target", () => {
  const f = fixture();
  const pagination = engine.paginate(f.session.script());
  const labels = ["1", "2", "2A", "3"];
  pagination.pages.forEach((page, i) => { page.number = labels[i]!; });
  engine.lockPages(f.doc, pagination);
  for (let i = 0; i < 3; i++) find(f.view(), (e) => e.props["aria-label"] === "Zoom in").props.onClick();
  const view = f.view();
  assert.deepEqual(elements(view).filter((e) => e.props.className === "story-map-tick")
    .map((e) => e.props.children.props.children), labels);
  const track = find(view, (e) => typeof e.type === "function" && e.props.pixelsPerPage !== undefined);
  const scene = find(f.render(track.type as Component, track.props), (e) => e.props["data-scene-id"] === "s3");
  assert.match(scene.props["aria-label"], /page 2A$/);
  const target = find(row(f), (e) => typeof e.type === "function" && e.type.name === "TargetField");
  const input = find(f.render(target.type as Component, target.props), (e) => e.type === "input");
  assert.equal(input.props.value, "p. 2A");
  for (const [value, position] of [["3", 0.75], ["2a", 0.5]] as const) {
    input.props.onChange({ target: { value } });
    input.props.onBlur();
    assert.equal(engine.structurePoints(f.doc)[0]!.position, position);
  }
});
