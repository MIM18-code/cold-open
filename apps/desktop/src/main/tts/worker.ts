// Bounded line-delimited JSON, serialized by ReaderRuntime. No shell and no renderer-selected executable.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
const MAX_REPLY = 24 * 1024 * 1024;
export class VoiceWorker {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending: { resolve(value: any): void; reject(error: Error): void; id: number } | null = null;
  private buffer = "";
  private sequence = 0;
  private readonly binary: string;
  constructor(binary: string) { this.binary = binary; }
  isRunning(): boolean { return this.child !== null; }
  stop(): void {
    const child = this.child; this.child = null; this.buffer = "";
    this.pending?.reject(new Error("Speech job cancelled.")); this.pending = null;
    child?.kill("SIGKILL");
  }
  private start(): void {
    if (this.child) return;
    // Even library fallback paths cannot make inference-time network requests.
    const child = spawn("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)(deny network*)", this.binary, "serve"], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, TOKENIZERS_PARALLELISM: "false", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" } });
    this.child = child; this.buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (this.child !== child) return;
      this.buffer += chunk;
      if (this.buffer.length > MAX_REPLY) { this.stop(); return; }
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
        try {
          const result = JSON.parse(line);
          if (result.id !== this.pending?.id) continue;
          const pending = this.pending!; this.pending = null;
          result.ok === true ? pending.resolve(result) : pending.reject(new Error(typeof result.error === "string" ? result.error : "Voice synthesis failed."));
        } catch { /* Library diagnostic output is not a protocol reply. */ }
      }
    });
    // Drain native diagnostics without writing screenplay text or tokens to logs.
    child.stderr.on("data", () => {});
    const exited = () => { if (this.child === child) { this.child = null; this.pending?.reject(new Error("The voice engine stopped. Load it again to retry.")); this.pending = null; } };
    child.on("error", exited); child.on("exit", exited);
    child.stdin.on("error", exited);
  }
  request(payload: Record<string, unknown>, signal: AbortSignal, timeoutMs: number): Promise<any> {
    signal.throwIfAborted();
    if (this.pending) return Promise.reject(new Error("The voice worker is already busy."));
    this.start();
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const cancel = () => this.stop();
      const timer = setTimeout(() => { this.pending?.reject(new Error("The voice engine timed out. Your script is unchanged.")); this.pending = null; this.stop(); }, timeoutMs);
      const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", cancel); };
      this.pending = { id, resolve: (v) => { finish(); resolve(v); }, reject: (e) => { finish(); reject(e); } };
      signal.addEventListener("abort", cancel, { once: true });
      this.child!.stdin.write(JSON.stringify({ ...payload, id }) + "\n", (error) => { if (error && this.pending?.id === id) { this.pending.reject(error); this.pending = null; } });
    });
  }
}
