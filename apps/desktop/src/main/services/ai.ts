// AI providers for proofreading and the assistant. Requests come in as "ai:start", text streams back as
// "ai:event" messages with the request ID. API keys live encrypted in userData and never leave this process.
import { app, dialog, safeStorage, shell } from "electron";
import { join } from "node:path";
import { execFile } from "node:child_process";

import { AI_CHANNELS, AI_SETTINGS, PROVIDERS, type AiRequest, type ProviderId } from "../../shared/channels/ai.ts";
import { backlotInfo } from "../ai/backlot.ts";
import { ChatgptDirect } from "../ai/chatgpt-direct.ts";
import { ChatgptOAuth, ChatgptStore } from "../ai/chatgpt-oauth.ts";
import { type Cipher, KeyStore } from "../ai/keys.ts";
import { AiRunner } from "../ai/runner.ts";
import { AiError } from "../ai/providers.ts";
import { localAiSetup } from "../ai/local-setup.ts";
import type { ServiceContext } from "../context.ts";

/** End-to-end tests must not touch the real keychain, so they use a plain reversible stand-in. Never in a packaged app: an environment variable must not switch encryption off. */
const testCipher: Cipher = {
  available: () => true,
  encrypt: (text) => Buffer.from(`test:${text}`),
  decrypt: (data) => data.toString().replace(/^test:/, ""),
};

const keychainCipher: Cipher = {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (text) => safeStorage.encryptString(text),
  decrypt: (data) => safeStorage.decryptString(data),
};

export function register(ctx: ServiceContext): void {
  const keys = new KeyStore(join(ctx.paths.userData, "ai-keys.json"), process.env.SCREENPLAY_E2E && !app.isPackaged ? testCipher : keychainCipher);
  const fetchFn = (url: string, init: RequestInit) => fetch(url, init);
  const account = new ChatgptOAuth({
    store: new ChatgptStore(join(ctx.paths.userData, "chatgpt.enc"), process.env.SCREENPLAY_E2E && !app.isPackaged ? testCipher : keychainCipher),
    fetch: fetchFn, openBrowser: (url) => shell.openExternal(url),
  });
  const runner = new AiRunner({ setting: (key) => ctx.settings.get(key) as never, keys, fetch: fetchFn,
    chatgpt: new ChatgptDirect(account, fetchFn) });
  ctx.onQuit(() => account.stop());

  const owner = (event: { sender: { id: number } }) => String(event.sender.id);
  const provider = (value: unknown): ProviderId => {
    if (!(PROVIDERS as readonly string[]).includes(value as string)) throw new Error("Unknown provider.");
    return value as ProviderId;
  };

  const watched = new Set<number>();
  ctx.handle(AI_CHANNELS.start, (event, request: AiRequest) => {
    const window = ctx.windowOf(event.sender);
    // A closed window stops its requests.
    const id = event.sender.id;
    if (!watched.has(id)) {
      watched.add(id);
      event.sender.once("destroyed", () => (watched.delete(id), runner.cancelOwner(String(id))));
    }
    return runner.start(owner(event), request, (message) => {
      if (window) ctx.send(window, AI_CHANNELS.event, message);
    }).catch((error) => ({ error: { code: error instanceof AiError ? error.code : "failed", message: error instanceof Error ? error.message : String(error) } }));
  });
  ctx.handle(AI_CHANNELS.cancel, (event, id: string) => runner.cancel(owner(event), String(id)));
  ctx.handle(AI_CHANNELS.status, () => runner.status());
  let setupOffered = false;
  ctx.handle(AI_CHANNELS.offerSetup, () => { const offer = !setupOffered; setupOffered = true; return offer; });
  ctx.handle(AI_CHANNELS.localSetup, () => runner.localReadiness("fresh"));
  ctx.handle(AI_CHANNELS.startOllama, () => new Promise<void>((resolve, reject) => {
    execFile("open", ["-a", "Ollama"], (error) => error ? reject(new Error("Could not start the Ollama app. Open it from Applications and try again.")) : resolve());
  }));
  ctx.handle(AI_CHANNELS.setKey, (_event, name: string, key: string) => runner.setKey(name, key));
  ctx.handle(AI_CHANNELS.clearKey, (_event, name: string) => runner.clearKey(name));
  ctx.handle(AI_CHANNELS.test, (_event, name: unknown) => runner.test(provider(name)));
  ctx.handle(AI_CHANNELS.models, async (_event, name: unknown) => runner.models(provider(name)));
  ctx.handle(AI_CHANNELS.backlot, () => backlotInfo(ctx.settings.get<string>(AI_SETTINGS.backlotPath)));
  ctx.handle(AI_CHANNELS.productionData, () => runner.productionData());
  ctx.handle(AI_CHANNELS.pickBacklot, async (event) => {
    const window = ctx.windowOf(event.sender);
    const options: Electron.OpenDialogOptions = { title: "Choose a Backlot project", properties: ["openFile"], filters: [{ name: "Backlot project", extensions: ["json"] }] };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    const path = result.filePaths[0];
    if (result.canceled || !path) return backlotInfo(ctx.settings.get<string>(AI_SETTINGS.backlotPath));
    // The only place the project is set: the assistant sends its contents to the chosen provider.
    ctx.settings.set(AI_SETTINGS.backlotPath, path);
    return backlotInfo(path);
  });
  ctx.handle(AI_CHANNELS.clearBacklot, () => ctx.settings.set(AI_SETTINGS.backlotPath, undefined));
  ctx.handle(AI_CHANNELS.chatgptLogin, (_event, value?: unknown) => {
    const options = value as { profileId?: unknown; newProfile?: unknown; consent?: unknown } | undefined;
    if (options && (typeof options !== "object" || Array.isArray(options)
      || (options.profileId !== undefined && typeof options.profileId !== "string")
      || (options.newProfile !== undefined && typeof options.newProfile !== "boolean")
      || (options.consent !== undefined && typeof options.consent !== "boolean"))) throw new Error("Invalid ChatGPT sign-in options.");
    void account.signIn({ profileId: options?.profileId as string | undefined,
      newProfile: options?.newProfile === true, consent: options?.consent === true }).catch(() => undefined);
    return account.status();
  });
  ctx.handle(AI_CHANNELS.chatgptLogout, async () => { await account.signOut(); return account.status(); });
  ctx.handle(AI_CHANNELS.chatgptCancelLogin, () => { account.cancelSignIn(); return account.status(); });
  ctx.handle(AI_CHANNELS.chatgptSelect, (_event, id: unknown) => {
    if (typeof id !== "string") throw new Error("Choose a ChatGPT connection.");
    account.select(id); return account.status();
  });
  ctx.handle(AI_CHANNELS.chatgptResume, () => { account.resume(); return account.status(); });
}
