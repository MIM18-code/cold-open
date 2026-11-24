import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { resolve } from "node:path";

// Run shareTakes with stand-ins for the cache folder and the share sheet, so what it leaves in the cache can be checked.
const root = resolve(import.meta.dirname, "..");
const stubs: Record<string, string> = {
  "expo-file-system": `export const cache = new Map(), disk = { stuck: false };
    export const Paths = { cache: "cache" };
    export class File { constructor(dir, name) { this.uri = dir + "/" + name; }
      get exists() { return cache.has(this.uri); }
      create() { cache.set(this.uri, ""); } async write(text) { cache.set(this.uri, text); }
      delete() { if (disk.stuck || !cache.delete(this.uri)) throw new Error("No file"); } }`,
  "react-native": `export const sheet = { action: "sharedAction", seen: [] };
    export const Share = { sharedAction: "sharedAction", dismissedAction: "dismissedAction",
      async share(content) { sheet.seen.push(content.url); return { action: sheet.action }; } };`,
};
const result = await build({ stdin: { contents: `export { shareTakes } from "./src/share.ts";
  export { cache, disk } from "expo-file-system"; export { sheet } from "react-native";`, resolveDir: root },
  bundle: true, write: false, platform: "node", format: "esm",
  plugins: [{ name: "stubs", setup(b) {
    b.onResolve({ filter: /.*/ }, args => args.path in stubs ? { path: args.path, namespace: "stubs" } : undefined);
    b.onLoad({ filter: /.*/, namespace: "stubs" }, ({ path }) => ({ contents: stubs[path], resolveDir: root }));
  } }],
});
const share = await import("data:text/javascript;base64," + Buffer.from(result.outputFiles[0]!.text).toString("base64"));

test("the takes file leaves the cache once the share sheet closes, shared or cancelled", async () => {
  assert.equal(await share.shareTakes("takes.coldopentakes", "{}"), true);
  assert.deepEqual(share.sheet.seen, ["cache/takes.coldopentakes"]);
  assert.equal(share.cache.size, 0);
  share.sheet.action = "dismissedAction";
  assert.equal(await share.shareTakes("takes.coldopentakes", "{}"), false);
  assert.equal(share.cache.size, 0);
});

test("a file the cache cannot delete does not turn a finished share into an error", async () => {
  share.disk.stuck = true; share.sheet.action = "sharedAction";
  assert.equal(await share.shareTakes("takes.coldopentakes", "{}"), true);
  share.disk.stuck = false;
});
