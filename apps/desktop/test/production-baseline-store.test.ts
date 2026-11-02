import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProductionBaselineStore, productionPathKey } from "../src/main/production/baseline-store.ts";
import { BASELINE_LIMIT, PRODUCTION_BASELINE } from "../src/shared/channels/production-baseline.ts";
import { register } from "../src/main/services/production-baseline.ts";
import type { Handler, ServiceContext } from "../src/main/context.ts";

const saved = { baseline: { version: 1 as const, scenes: [], sentAt: "2026-11-01", projectId: "project" } };

test("production baselines round trip across store instances, use private hashed files and normalize paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "production-baseline-"));
  try {
    const directory = join(root, "baselines"), path = join(root, "Draft.fdx"), store = new ProductionBaselineStore(directory);
    await writeFile(path, "<FinalDraft><Content/></FinalDraft>");
    assert.equal(await store.get(path), null);
    await store.set(root + "/unused/../Draft.fdx", saved);
    const name = productionPathKey(path) + ".json";
    assert.deepEqual(await readdir(directory), [name]);
    assert.equal((await stat(join(directory, name))).mode & 0o777, 0o600);
    assert.deepEqual(await new ProductionBaselineStore(directory).get(path), saved);
    await store.set(path, null);
    assert.equal(await store.get(path), null);
    assert.throws(() => productionPathKey("../secret"), /Invalid/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("corrupt and oversized baselines are refused without overwriting them", async () => {
  const root = await mkdtemp(join(tmpdir(), "production-baseline-"));
  try {
    const store = new ProductionBaselineStore(root), path = "/scripts/Draft.fountain";
    const file = join(root, productionPathKey(path) + ".json");
    for (const bad of ["{", JSON.stringify({ path, value: { baseline: { ...saved.baseline, scenes: [{}] } } }),
      JSON.stringify({ path: "/scripts/Other.fountain", value: saved }), " ".repeat(BASELINE_LIMIT + 1)]) {
      await writeFile(file, bad);
      await assert.rejects(store.get(path));
      assert.equal(await readFile(file, "utf8"), bad);
    }
    assert.throws(() => store.set(path, { baseline: { ...saved.baseline, projectId: "x".repeat(BASELINE_LIMIT) } }), /limit/);
    assert.throws(() => store.set(path, { baseline: {} }), /Invalid/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("baseline IPC requires a script grant for both reads and writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "production-baseline-"));
  try {
    const chosen = join(root, "Chosen.fdx");
    await writeFile(chosen, "<FinalDraft><Content/></FinalDraft>");
    const handlers = new Map<string, Handler>();
    register({ paths: { userData: root }, handle: (channel: string, fn: Handler) => handlers.set(channel, fn),
      isAllowedPath: (path: string) => path === chosen, onQuit: () => {} } as unknown as ServiceContext);
    const get = (path: unknown) => handlers.get(PRODUCTION_BASELINE.get)!({} as never, path);
    const set = (path: unknown, value: unknown) => handlers.get(PRODUCTION_BASELINE.set)!({} as never, path, value);
    for (const path of [null, {}, "relative", "/scripts/Other.fdx"]) {
      assert.throws(() => get(path));
      assert.throws(() => set(path, saved));
    }
    await set(chosen, saved);
    assert.deepEqual(await get(chosen), saved);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Finder renames and byte-identical duplicates start fresh without stealing a baseline", async () => {
  const folder = await mkdtemp(join(tmpdir(), "baseline-rename-")), root = join(folder, "baselines");
  try {
    const original = join(folder, "Draft.fountain"), renamed = join(folder, "Renamed.fountain");
    const contents = "INT. ROOM - DAY\n", store = new ProductionBaselineStore(root);
    await writeFile(original, contents);
    await store.set(original, saved);
    await writeFile(renamed, contents);
    assert.equal(await store.get(renamed), null);
    assert.deepEqual(await store.get(original), saved);
    await rm(renamed);
    await rename(original, renamed);
    assert.equal(await new ProductionBaselineStore(root).get(renamed), null);
    assert.deepEqual(await readdir(root), [productionPathKey(original) + ".json"]);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("baselines belong to paths even when script contents or inodes change", async () => {
  const folder = await mkdtemp(join(tmpdir(), "baseline-path-"));
  try {
    const path = join(folder, "Draft.fountain"), store = new ProductionBaselineStore(join(folder, "baselines"));
    await writeFile(path, "INT. ROOM - DAY\n");
    await store.set(path, saved);
    await writeFile(path, "EXT. DIFFERENT - NIGHT\n");
    assert.deepEqual(await store.get(path), saved);
    await writeFile(join(folder, "Replacement.fountain"), "INT. REPLACEMENT - DAY\n");
    await rename(join(folder, "Replacement.fountain"), path);
    assert.deepEqual(await new ProductionBaselineStore(join(folder, "baselines")).get(path), saved);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("writes prune a script that is gone from its folder, but keep one whose folder is missing (an unmounted drive)", async () => {
  const folder = await mkdtemp(join(tmpdir(), "baseline-prune-")), root = join(folder, "baselines");
  try {
    const store = new ProductionBaselineStore(root);
    const paths = [join(folder, "Deleted.fountain"), join(folder, "sub", "Draft.fountain"), join(folder, "Kept.fountain")];
    await mkdir(join(folder, "sub"));
    for (const path of paths) { await writeFile(path, "INT. ROOM - DAY\n"); await store.set(path, saved); }
    await rm(paths[0]!);
    await rm(join(folder, "sub"), { recursive: true });
    // Cleanup happens on writes, never merely opening another script.
    assert.deepEqual(await store.get(paths[2]!), saved);
    assert.equal((await readdir(root)).length, 3);
    await store.set(paths[2]!, saved);
    assert.deepEqual((await readdir(root)).sort(), [productionPathKey(paths[1]!) + ".json", productionPathKey(paths[2]!) + ".json"].sort());
    await assert.rejects(store.set(paths[0]!, saved), /Save the script/);
    assert.deepEqual(await store.get(paths[2]!), saved);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("existing script baselines survive writes beyond the former total quota", async () => {
  const folder = await mkdtemp(join(tmpdir(), "baseline-retain-")), root = join(folder, "baselines");
  try {
    const store = new ProductionBaselineStore(root), paths: string[] = [];
    const payload = { baseline: { ...saved.baseline, projectId: "p".repeat(7_200_000) } };
    for (let i = 0; i < 9; i++) {
      const path = join(folder, i + ".fountain");
      paths.push(path);
      await writeFile(path, "INT. ROOM - DAY\n");
      await store.set(path, payload);
    }
    const entries = await readdir(root);
    assert.equal(entries.length, paths.length);
    const sizes = await Promise.all(entries.map(name => stat(join(root, name))));
    assert.ok(sizes.reduce((total, info) => total + info.size, 0) > 64_000_000);
    assert.ok(sizes.every(info => info.size <= BASELINE_LIMIT));
    for (const path of paths) assert.deepEqual(await new ProductionBaselineStore(root).get(path), payload);
    assert.throws(() => store.set(paths[0]!, { baseline: { ...saved.baseline, projectId: "x".repeat(BASELINE_LIMIT) } }), /limit/);
    assert.deepEqual(await store.get(paths[0]!), payload);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
