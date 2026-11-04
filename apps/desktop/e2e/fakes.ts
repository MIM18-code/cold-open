// Stand-ins for the speech helper and the local model server, so dictation runs end to end with no microphone,
// model or network. The helper speaks `speech-helper serve` (one JSON request per line); the server answers the
// two Ollama endpoints the formatter uses.
import { chmodSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

/** Write an executable fake helper into `folder` that hears `spoken` for every take. Returns its path. */
export function fakeSpeechHelper(folder: string, spoken: string, delayMs = 0): string {
  // Chosen through the Choose dialog in tests; the name does not matter.
  const path = join(folder, "speech-helper");
  writeFileSync(path, `#!${process.execPath}
import { createInterface } from "node:readline";
const reply = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
if (process.argv[2] === "engines") {
  reply({ engines: ["parakeet"] });
  process.exit(0);
}
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.op === "prepare") return reply({ id: request.id, ok: true, loadMs: 1 });
  if (request.op === "transcribe") {
    return setTimeout(() => reply({ id: request.id, ok: true, result: { engine: "fake", text: ${JSON.stringify(spoken)}, words: [], audioSeconds: 1, transcribeMs: 1 } }), ${delayMs});
  }
  reply({ id: request.id, ok: false, error: "unknown op" });
});
`);
  chmodSync(path, 0o755);
  return path;
}

export interface FakeModel {
  endpoint: string;
  close(): Promise<void>;
}

/** An Ollama stand-in whose chat replies are always `proposal`, as the dictation formatter's JSON. */
export async function fakeModelServer(proposal: unknown): Promise<FakeModel> {
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/tags") return response.end(JSON.stringify({ models: [{ name: "qwen3.5:4b" }] }));
      if (request.url === "/api/chat") return response.end(JSON.stringify({ message: { content: JSON.stringify(proposal) }, done: true, done_reason: "stop" }));
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise((resolve) => (server.closeAllConnections(), server.close(() => resolve()))),
  };
}
