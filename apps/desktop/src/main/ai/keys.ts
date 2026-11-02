// API keys, encrypted at rest and never handed to the renderer. The cipher is Electron's safeStorage in the app
// (the macOS keychain holds its key) and a stand-in in tests.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { KEYED_PROVIDERS, type KeyedProvider } from "../../shared/channels/ai.ts";

export interface Cipher {
  available(): boolean;
  encrypt(text: string): Buffer;
  decrypt(data: Buffer): string;
}

export function isKeyedProvider(value: unknown): value is KeyedProvider {
  return (KEYED_PROVIDERS as readonly string[]).includes(value as string);
}

export class KeyStore {
  private readonly file: string;
  private readonly cipher: Cipher;

  constructor(file: string, cipher: Cipher) {
    this.file = file;
    this.cipher = cipher;
  }

  get encryption(): boolean {
    return this.cipher.available();
  }

  private read(): Record<string, string> {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  private write(values: Record<string, string>): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify(values), { mode: 0o600 });
    renameSync(temp, this.file);
  }

  has(provider: KeyedProvider): boolean {
    return typeof this.read()[provider] === "string";
  }

  /** For the main process only, when it builds a request. */
  get(provider: KeyedProvider): string | undefined {
    const stored = this.read()[provider];
    if (typeof stored !== "string" || !this.cipher.available()) return undefined;
    try {
      return this.cipher.decrypt(Buffer.from(stored, "base64"));
    } catch {
      return undefined;
    }
  }

  set(provider: KeyedProvider, key: string): void {
    const trimmed = key.trim();
    if (!trimmed) throw new Error("Paste the key first.");
    if (/\s/.test(trimmed)) throw new Error("A key has no spaces. Check what was pasted.");
    if (!this.cipher.available()) throw new Error("This Mac can't encrypt the key, so it was not saved.");
    this.write({ ...this.read(), [provider]: this.cipher.encrypt(trimmed).toString("base64") });
  }

  clear(provider: KeyedProvider): void {
    const values = this.read();
    delete values[provider];
    this.write(values);
  }
}
