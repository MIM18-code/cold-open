import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileSHA256 } from "../models/voice-manager.ts";
import { validWave } from "./runtime.ts";

export interface VoiceReference {
  id: string;
  label: string;
  transcript: string;
  description: string;
  tags: string[];
  provenance: string;
  generatorVersion: string;
  modelChecksum: string;
  audioChecksum: string;
}
export function referenceChecksum(reference: VoiceReference): string {
  return createHash("sha256").update(JSON.stringify(reference)).digest("hex");
}
export class ReferenceBank {
  readonly root: string;
  constructor(root: string) { this.root = root; }
  async save(reference: Omit<VoiceReference, "audioChecksum">, audio: Uint8Array, signal?: AbortSignal): Promise<VoiceReference> {
    signal?.throwIfAborted();
    if (!/^[a-z0-9-]{1,80}$/.test(reference.id) || !reference.transcript.trim() || !reference.provenance ||
      !reference.generatorVersion || !reference.modelChecksum || !validWave(audio)) throw new Error("Invalid voice reference.");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if ((await lstat(this.root)).isSymbolicLink()) throw new Error("Unsafe reference bank directory.");
    // Never overwrite an accepted voice identity. A redesign receives a new ID.
    const destination = join(this.root, reference.id);
    if (await lstat(destination).catch(() => null)) throw new Error("This reference voice already exists. Choose a new ID.");
    const temporary = join(this.root, `.new-${randomUUID()}`);
    await mkdir(temporary, { mode: 0o700 });
    const saved = { ...reference, audioChecksum: createHash("sha256").update(audio).digest("hex") };
    try {
      await writeFile(join(temporary, "audio.wav"), audio, { mode: 0o600 });
      await writeFile(join(temporary, "reference.json"), JSON.stringify(saved, null, 2), { mode: 0o600 });
      signal?.throwIfAborted();
      await rename(temporary, destination);
    } finally { await rm(temporary, { recursive: true, force: true }); }
    if (signal?.aborted) { await this.remove(reference.id); signal.throwIfAborted(); }
    return saved;
  }
  async remove(id: string): Promise<void> {
    if (!/^[a-z0-9-]{1,80}$/.test(id)) throw new Error("Invalid reference voice ID.");
    const root = await lstat(this.root).catch(() => null);
    if (!root) return;
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("Unsafe reference bank directory.");
    await rm(join(this.root, id), { recursive: true, force: true });
  }
  async get(id: string): Promise<{ reference: VoiceReference; audioPath: string }> {
    if (!/^[a-z0-9-]{1,80}$/.test(id)) throw new Error("Invalid reference voice ID.");
    const directory = join(this.root, id), audioPath = join(directory, "audio.wav"), metadata = join(directory, "reference.json");
    for (const path of [this.root, directory, audioPath, metadata]) {
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error("Unsafe reference voice asset.");
    }
    if ((await lstat(metadata)).size > 32_768 || (await lstat(audioPath)).size > 16 * 1024 * 1024) throw new Error("Reference asset exceeds the size limit.");
    const reference = JSON.parse(await readFile(metadata, "utf8")) as VoiceReference;
    if (reference.id !== id || typeof reference.transcript !== "string" || !reference.transcript.trim() ||
      !reference.provenance || !reference.generatorVersion || !reference.modelChecksum || !Array.isArray(reference.tags) ||
      !/^[a-f0-9]{64}$/.test(reference.audioChecksum) || await fileSHA256(audioPath) !== reference.audioChecksum) {
      throw new Error("Voice reference verification failed.");
    }
    return { reference, audioPath };
  }
  async list(): Promise<VoiceReference[]> {
    const ids = await readdir(this.root).catch(() => [] as string[]);
    const references: VoiceReference[] = [];
    for (const id of ids.filter((id) => /^[a-z0-9-]{1,80}$/.test(id))) {
      try { references.push((await this.get(id)).reference); } catch { /* Incomplete references cannot be cast. */ }
    }
    return references;
  }
}
