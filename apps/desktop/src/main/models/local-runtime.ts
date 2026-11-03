// The optional Mac runtime comes from Ollama's release assets. Verify the pinned archive before extracting it.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { DEFAULT_OLLAMA_ENDPOINT } from "../../shared/channels/ai.ts";
import { OllamaModels } from "./ollama.ts";
import { fileSHA256 } from "./voice-manager.ts";

const exec = promisify(execFile);
const VERSION = "0.40.13";
const ARCHIVE = `https://github.com/ollama/ollama/releases/download/v${VERSION}/ollama-darwin.tgz`;
const SHA256 = "bae29252232b9e1358cf5801a7d65a07442af18fb5467cb68c7fc3711f59c511";

export async function installRuntime(root: string, signal: AbortSignal): Promise<string> {
  if (process.platform !== "darwin") throw new Error("Automatic local AI setup needs macOS.");
  const destination = join(root, `ollama-${VERSION}`);
  const binary = join(destination, "ollama");
  if (existsSync(binary)) return binary;
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stage = await mkdtemp(join(root, ".install-"));
  try {
    const archive = join(stage, "download.tgz");
    await exec("/usr/bin/curl", ["-q", "--fail", "--silent", "--show-error", "--location", "--proto", "=https",
      "--proto-redir", "=https", "--max-filesize", "186689993", "--connect-timeout", "20", "--max-time", "1800",
      "--output", archive, ARCHIVE], { signal });
    if (await fileSHA256(archive) !== SHA256) throw new Error("The download did not match Ollama’s release.");
    const unpacked = join(stage, "runtime");
    await mkdir(unpacked);
    await exec("/usr/bin/tar", ["-xzf", archive, "-C", unpacked], { signal });
    signal.throwIfAborted();
    await rename(unpacked, destination);
    return binary;
  } catch (error) {
    signal.throwIfAborted();
    if (existsSync(binary)) return binary; // Another app instance finished the same verified release.
    throw new Error("Could not install local AI. Check your internet connection and free space, then try again.", { cause: error });
  } finally { await rm(stage, { recursive: true, force: true }); }
}

export class LocalRuntime {
  private child?: ChildProcess;
  private readonly root: string;
  constructor(userData: string) { this.root = join(userData, "local-ai"); }

  async start(signal: AbortSignal, report: (message: string) => void, allowDownload: boolean): Promise<void> {
    const models = new OllamaModels();
    if (await models.list().then(() => true, () => false)) return;
    signal.throwIfAborted();
    let binary = [join(this.root, `ollama-${VERSION}`, "ollama"), "/Applications/Ollama.app/Contents/Resources/ollama",
      join(homedir(), "Applications/Ollama.app/Contents/Resources/ollama"), "/opt/homebrew/bin/ollama", "/usr/local/bin/ollama"].find(existsSync);
    if (!binary) {
      if (!allowDownload) return;
      report("Downloading and verifying Ollama (187 MB)…");
      binary = await installRuntime(this.root, signal);
    }
    signal.throwIfAborted();
    report("Starting local AI…");
    if (!this.child) {
      const child = spawn(binary, ["serve"], { stdio: "ignore", env: {
        ...process.env, OLLAMA_HOST: new URL(DEFAULT_OLLAMA_ENDPOINT).host, OLLAMA_NO_CLOUD: "1",
      } });
      this.child = child;
      child.once("error", () => {}); // Failure to start also emits close.
      child.once("close", () => { if (this.child === child) this.child = undefined; });
    }
    for (let attempt = 0; attempt < 50; attempt++) {
      await delay(300, undefined, { signal });
      if (await models.list().then(() => true, () => false)) return;
      if (!this.child) break;
    }
    throw new Error("Local AI could not start. Close other copies of Ollama and try again.");
  }

  stop(): void { this.child?.kill(); }
}
