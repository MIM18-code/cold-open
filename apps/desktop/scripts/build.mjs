// Bundles main and preload with esbuild and the renderer with Vite. `--watch` rebuilds main and preload on change.
import { build, context } from "esbuild";
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build as viteBuild } from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const watch = process.argv.includes("--watch");
const skipRenderer = process.argv.includes("--no-renderer");

const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  sourcemap: true,
  external: ["electron"],
  logLevel: "info",
};
const targets = [
  // Main is ESM; preload must be CommonJS because sandboxed preloads cannot be modules.
  { ...common, entryPoints: [join(root, "src/main/index.ts")], outfile: join(root, "dist/main/index.js"), format: "esm",
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" } },
  { ...common, entryPoints: [join(root, "src/preload/index.ts")], outfile: join(root, "dist/preload/index.cjs"), format: "cjs" },
];

// The dictation formatter reads its prompt next to its own module at run time.
mkdirSync(join(root, "dist/main"), { recursive: true });
cpSync(join(root, "../../packages/dictation/src/format_scene.txt"), join(root, "dist/main/format_scene.txt"));

if (watch) {
  for (const options of targets) await (await context(options)).watch();
} else {
  await Promise.all(targets.map((options) => build(options)));
  if (!skipRenderer) await viteBuild({ configFile: join(root, "vite.config.ts") });
}
