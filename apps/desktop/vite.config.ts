import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// The renderer. Main and preload are bundled by scripts/build.mjs with esbuild. Paths are absolute so the build
// works from any directory.
export default defineConfig({
  root: fileURLToPath(new URL("src/renderer", import.meta.url)),
  base: "./",
  plugins: [react()],
  build: { outDir: fileURLToPath(new URL("dist/renderer", import.meta.url)), emptyOutDir: true, target: "chrome140" },
  server: { port: 5199, strictPort: true },
});
