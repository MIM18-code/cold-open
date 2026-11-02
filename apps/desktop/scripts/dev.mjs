// Development: Vite serves the renderer with hot reload, esbuild watches main and preload, Electron loads the dev server.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const server = await createServer({ configFile: join(root, "vite.config.ts") });
await server.listen();
const url = server.resolvedUrls?.local[0] ?? "http://localhost:5199/";

const watcher = spawn(process.execPath, [join(root, "scripts/build.mjs"), "--watch"], { stdio: "inherit" });
await new Promise((resolve) => setTimeout(resolve, 1500));
const electron = (await import("electron")).default;
const app = spawn(electron, [root], { stdio: "inherit", env: { ...process.env, SCREENPLAY_DEV_URL: url } });
app.on("exit", async () => {
  watcher.kill();
  await server.close();
  process.exit(0);
});
