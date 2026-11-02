import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { close, launch } from "./helpers.ts";

test("phone Reader adds margin marks when metadata arrives after text layout", async () => {
  // Run the shipped Reader with real React. Native controls use DOM adapters that emit a
  // layout event only when text changes, matching native suppression of identical layouts.
  const bundle = await build({
    stdin: { resolveDir: resolve(import.meta.dirname, "..", "..", "mobile"), contents: `
      import { createElement } from "react";
      import { createRoot } from "react-dom/client";
      import { flushSync } from "react-dom";
      import { Reader } from "./src/Reader";
      const host = document.createElement("div");
      host.dataset.testid = "phone-reader";
      document.body.append(host);
      const root = createRoot(host);
      const row = { id: "p", type: "action", runs: [{ text: "Original. Revised." }], text: "Original. Revised.", scene: "Scene 1" };
      const people = { title: "Script", writers: [], cursor: null, offset: 0 };
      const render = (rows, presence) => flushSync(() => root.render(createElement(Reader, {
        rows, people: presence, status: "Live", secure: true, showStatus() {}, compose() {},
      })));
      window.__readerRevision = () => {
        const set = { id: "1", name: "Blue", mark: "+", color: "#0000ff", date: "", style: "" };
        render([{ ...row, runs: [{ text: "Original. " }, { text: "Revised.", fdx: { RevisionID: "1" } }] }],
          { ...people, production: { v: 2, active: set, sets: [set], scenes: [], lockedPages: [],
            marks: { p: { label: "Blue", color: set.color } } } });
      };
      window.__readerUnmount = () => { root.unmount(); host.remove(); };
      window.__readerLayouts = 0;
      render([row], people);
    ` }, bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
    alias: { react: dirname(createRequire(import.meta.url).resolve("react")) },
    plugins: [{ name: "reader-native-controls", setup(b) {
      b.onResolve({ filter: /^(react-native|expo-symbols)$/ }, args => ({ path: args.path, namespace: "native" }));
      b.onLoad({ filter: /.*/, namespace: "native" }, ({ path }) => ({ resolveDir: resolve(import.meta.dirname, ".."), contents: path === "expo-symbols"
        ? `export const SymbolView = () => null;` : `
        import { createElement as h, Fragment, useLayoutEffect } from "react";
        const textOf = value => Array.isArray(value) ? value.map(textOf).join("")
          : typeof value === "string" ? value : value?.props ? textOf(value.props.children) : "";
        const styleOf = value => Array.isArray(value) ? Object.assign({}, ...value.map(styleOf))
          : typeof value === "function" ? value({ pressed: false }) : value;
        function element(tag, props) {
          return h(tag, { style: styleOf(props.style), onClick: props.onPress,
            role: props.accessibilityRole, "aria-label": props.accessibilityLabel,
            "aria-hidden": props.accessibilityElementsHidden, "data-paragraph": props.onTextLayout ? "true" : undefined }, props.children);
        }
        export const View = props => element("div", props), ScrollView = View;
        export const Pressable = props => element("div", props);
        export const TextInput = props => h("input", { "aria-label": props.accessibilityLabel });
        export function Text(props) {
          const text = textOf(props.children);
          useLayoutEffect(() => {
            if (props.onTextLayout) {
              window.__readerLayouts++;
              props.onTextLayout({ nativeEvent: { lines: [
                { text: "Original. ", y: 0, height: 20 }, { text: "Revised.", y: 20, height: 20 },
              ] } });
            }
          }, [text]);
          return element("span", props);
        }
        export function FlatList(props) {
          return h("div", null, props.ListHeaderComponent, props.data.map(item =>
            h(Fragment, { key: props.keyExtractor(item) }, props.renderItem({ item }))));
        }
        export const useColorScheme = () => "light", PlatformColor = () => "#000000";
        export const Alert = { alert() { throw Error("Unexpected alert"); } };
      ` }));
    } }],
  });
  const { page, electronApp } = await launch();
  try {
    await page.evaluate(code => { (0, eval)(code); }, bundle.outputFiles[0]!.text);
    const reader = page.getByTestId("phone-reader"), paragraph = reader.locator('[data-paragraph="true"]');
    await expect(paragraph).toHaveText("Original. Revised.");
    await expect(reader.locator('[aria-hidden="true"]')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__readerLayouts)).toBe(1);
    await paragraph.evaluate(node => { (window as any).__readerParagraph = node; });
    await page.evaluate(() => (window as any).__readerRevision());
    const mark = reader.locator('[aria-hidden="true"]');
    await expect(mark).toHaveText("+");
    await expect(mark).toHaveCSS("top", "20px");
    await expect(mark).toHaveCSS("color", "rgb(0, 0, 255)");
    expect(await paragraph.evaluate(node => node === (window as any).__readerParagraph)).toBe(true);
    expect(await page.evaluate(() => (window as any).__readerLayouts)).toBe(1);
  } finally {
    await page.evaluate(() => (window as any).__readerUnmount?.()).catch(() => undefined);
    await close(electronApp, page);
  }
});
