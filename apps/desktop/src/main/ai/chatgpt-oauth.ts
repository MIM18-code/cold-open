import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname } from "node:path";

import { PLAN_LIMIT_MESSAGE, type ChatgptStatus } from "../../shared/channels/ai.ts";
import type { Cipher } from "./keys.ts";
import { boundedJson, connectionError, diagnosticCode, object, request, requestIdOf, untilAborted } from "./chatgpt-http.ts";
import { AiError, type FetchLike } from "./providers.ts";

const ISSUER = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const DIRECT_SCOPE = "chatgpt.tokens.use.direct";
const SCOPES = `openid profile email offline_access resource.invoke ${DIRECT_SCOPE}`;
const DYNAMIC_CLIENT = "dynamic_agent_client";
const TERMINAL_REFRESH = new Set(["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired",
  "refresh_token_invalidated", "refresh_token_reused"]);

interface Tokens {
  id: string;
  access?: string;
  refresh?: string;
  scopes: string[];
  expiresAt: number;
  /** Saved before its ID token was checked; nothing uses the access token until the check passes. */
  unverified?: boolean;
}
interface Profile {
  id: string;
  clientId: string;
  subject?: string;
  email?: string;
  tokens?: Tokens;
  paused?: boolean;
}
interface SavedState {
  hostId: string;
  active?: string;
  profiles: Profile[];
  /**
   * A registration OpenAI issued whose code exchange did not complete. The sign-in page says to start the next
   * authorization "with the issued client ID retained for this attempt", not with a new registration.
   */
  retry?: string;
}

/** This file is separate from renderer-readable settings and document data. */
export class ChatgptStore {
  private readonly file: string;
  private readonly cipher: Cipher;
  private usable: boolean | undefined;
  constructor(file: string, cipher: Cipher) { this.file = file; this.cipher = cipher; }

  /** For status checks: the last answer, without asking the keychain again. */
  get available(): boolean { return this.usable ?? true; }
  canEncrypt(): boolean { return (this.usable = this.cipher.available()); }

  read(): SavedState {
    let encrypted: Buffer;
    try { encrypted = readFileSync(this.file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { hostId: `urn:uuid:${randomUUID()}`, profiles: [] };
      throw new AiError("not-configured", "The saved ChatGPT connection could not be read.");
    }
    if (!this.canEncrypt()) throw new AiError("not-configured", "This Mac cannot unlock the saved ChatGPT connection.");
    try {
      const state = JSON.parse(this.cipher.decrypt(encrypted)) as SavedState;
      if (!state.hostId?.startsWith("urn:uuid:") || !Array.isArray(state.profiles)) throw new Error();
      return state;
    } catch { throw new AiError("not-configured", "The saved ChatGPT connection could not be unlocked."); }
  }

  write(state: SavedState): void {
    if (!this.canEncrypt()) throw new AiError("not-configured", "This Mac cannot encrypt ChatGPT credentials.");
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, this.cipher.encrypt(JSON.stringify(state)), { mode: 0o600 });
    renameSync(temp, this.file);
  }
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function callbackReceiver(state: string): (params: URLSearchParams) => URLSearchParams {
  let used = false;
  return (params) => {
    if (used) throw new AiError("unauthorized", "This ChatGPT callback was already used.");
    used = true;
    if (!["state", "code", "client_id", "error"].every((name) => params.getAll(name).length <= 1)
      || !equal(params.get("state") ?? "", state)) {
      throw new AiError("unauthorized", "ChatGPT sign-in state did not match. Sign in again.");
    }
    return params;
  };
}

export async function loopback(state: string, signal: AbortSignal): Promise<{ redirectUri: string; callback: Promise<URLSearchParams> }> {
  let resolve!: (params: URLSearchParams) => void;
  let reject!: (reason: unknown) => void;
  const callback = new Promise<URLSearchParams>((yes, no) => { resolve = yes; reject = no; });
  // The browser may fail to open before the caller begins awaiting the callback.
  void callback.catch(() => undefined);
  let used = false;
  const consume = callbackReceiver(state);
  const server = createServer({ maxHeaderSize: 8192 }, (req, res) => {
    res.setHeader("Connection", "close");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    let url: URL;
    try { url = new URL(req.url ?? "/", "http://127.0.0.1"); }
    catch { res.writeHead(400).end("Invalid callback."); return; }
    if (used || req.method !== "GET" || url.pathname !== "/auth/callback") {
      res.writeHead(404).end("Not found.");
      return;
    }
    used = true;
    close();
    try {
      const params = consume(url.searchParams);
      res.writeHead(200).end("Return to Cold Open to finish signing in.");
      resolve(params);
    } catch (error) {
      res.writeHead(400).end("Sign-in could not be verified.");
      reject(error);
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  const close = () => {
    signal.removeEventListener("abort", abort);
    server.close();
    server.closeIdleConnections();
  };
  const abort = () => {
    used = true;
    close();
    server.closeAllConnections();
    reject(new AiError("cancelled", "ChatGPT sign-in cancelled or timed out."));
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    await new Promise<void>((yes, no) => {
      server.once("error", no);
      server.listen(0, "127.0.0.1", () => { server.off("error", no); yes(); });
    });
    signal.throwIfAborted();
  } catch (error) { close(); throw error; }
  const address = server.address();
  if (!address || typeof address === "string") { close(); throw new Error("Could not start sign-in callback."); }
  return { redirectUri: `http://127.0.0.1:${address.port}/auth/callback`, callback };
}

interface Metadata {
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint: string;
  jwks_uri: string;
}
interface OAuthDeps {
  store: ChatgptStore;
  fetch: FetchLike;
  openBrowser(url: string): Promise<unknown>;
  /** Main-process injection for fake servers only, never a renderer setting. */
  issuer?: string;
  now?: () => number;
  listen?: typeof loopback;
}

export class ChatgptOAuth {
  private state: SavedState | undefined;
  /** Why a saved connection could not be unlocked. Status reports it instead of asking the keychain again; signing in or out retries. */
  private locked: string | undefined;
  private pending: AbortController | undefined;
  private refreshing: { profile: Profile; promise: Promise<string> } | undefined;
  private session = new AbortController();
  /** Renewals have their own lifetime, so sign-out can stop inference at once and still let one settle. */
  private renewal = new AbortController();
  private note: string | undefined;
  private signingOut = false;
  private readonly renewedAfter401 = new Set<string>();
  private readonly issuer: string;
  private readonly now: () => number;
  private readonly deps: OAuthDeps;

  constructor(deps: OAuthDeps) {
    this.deps = deps;
    this.issuer = deps.issuer ?? ISSUER;
    this.now = deps.now ?? Date.now;
  }

  private saved(): SavedState { this.state ??= this.deps.store.read(); this.locked = undefined; return this.state; }
  private active(): Profile | undefined { const saved = this.saved(); return saved.profiles.find((p) => p.id === saved.active); }
  private save(): void { this.deps.store.write(this.saved()); }
  private endRequests(): void {
    this.session.abort(); this.session = new AbortController();
    this.renewal.abort(); this.renewal = new AbortController();
  }
  get signal(): AbortSignal { return this.session.signal; }

  status(): ChatgptStatus {
    if (this.locked) return { available: this.deps.store.available, signedIn: false, pending: !!this.pending, note: this.locked };
    try {
      const saved = this.saved(), profile = this.active();
      const signedIn = !!profile?.tokens;
      const planUsageGranted = !!profile?.tokens?.access && profile.tokens.scopes.includes(DIRECT_SCOPE);
      return {
        available: this.deps.store.available, signedIn, pending: !!this.pending,
        planUsageGranted, paused: !!profile?.paused, email: profile?.email,
        activeProfile: saved.active,
        profiles: saved.profiles.map((p, index) => ({ id: p.id, label: `Connection ${index + 1}${p.email ? ` (${p.email})` : ""}` })),
        note: this.note ?? (profile?.paused ? "ChatGPT plan requests are paused. Check usage, then resume in Settings > AI."
          : signedIn && !planUsageGranted ? "ChatGPT plan usage is not enabled. Enable it to send requests."
          : !signedIn ? "Continue with ChatGPT to connect an eligible plan." : undefined),
      };
    } catch (error) {
      this.locked = error instanceof Error ? error.message : "Could not unlock ChatGPT.";
      return { available: this.deps.store.available, signedIn: false, pending: !!this.pending, note: this.locked };
    }
  }

  private async metadata(signal: AbortSignal): Promise<Metadata> {
    const response = await request(this.deps.fetch, `${this.issuer}/.well-known/openid-configuration`, { method: "GET" }, signal);
    if (!response.ok) throw new AiError("unreachable", "ChatGPT sign-in discovery failed.");
    const data = await boundedJson(response, signal);
    if (data.issuer !== this.issuer) throw new AiError("unauthorized", "ChatGPT sign-in issuer did not match.");
    const endpoint = (name: string) => {
      const value = data[name];
      if (typeof value !== "string" || new URL(value).origin !== this.issuer) {
        throw new AiError("unauthorized", "ChatGPT sign-in discovery returned an invalid endpoint.");
      }
      return value;
    };
    return { authorization_endpoint: endpoint("authorization_endpoint"), token_endpoint: endpoint("token_endpoint"),
      revocation_endpoint: endpoint("revocation_endpoint"), jwks_uri: endpoint("jwks_uri") };
  }

  private async identity(token: string, clientId: string, nonce: string | undefined, metadata: Metadata, signal: AbortSignal) {
    const invalid = () => new AiError("unauthorized", "ChatGPT identity could not be verified. Sign in again.");
    // Fetching the keys can fail for ordinary network reasons; that is temporary and must not cost the credentials.
    // Only a token that fails verification is an identity problem.
    let jwks: Record<string, unknown>;
    try {
      const response = await request(this.deps.fetch, metadata.jwks_uri, { method: "GET" }, signal);
      if (!response.ok) {
        await response.body?.cancel();
        throw new AiError("unreachable", `ChatGPT's signing keys could not be fetched (HTTP ${response.status}). Try again.`);
      }
      jwks = await boundedJson(response, signal);
    } catch (error) { throw connectionError(signal, error); }
    try {
      // OpenAI's verification example (siwc "On your website", which its sign-in page says applies here): a maintained
      // JWT library, the issuer, the issued client ID as audience, sub, exp and iat required, and a small clock
      // tolerance. The keys come fresh from the published JWKS on every sign-in and renewal.
      const { payload: claims } = await jwtVerify(token, createLocalJWKSet(jwks as unknown as JSONWebKeySet), {
        issuer: this.issuer, audience: clientId, algorithms: ["RS256"], requiredClaims: ["sub", "exp", "iat"],
        clockTolerance: 5, currentDate: new Date(this.now()),
      });
      const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if ((audiences.length > 1 && claims.azp !== clientId) || (claims.azp !== undefined && claims.azp !== clientId)
        || typeof claims.sub !== "string" || !claims.sub || (nonce !== undefined && claims.nonce !== nonce)
        || (claims.sid !== undefined && (typeof claims.sid !== "string" || !claims.sid.trim()))) throw invalid();
      return { subject: claims.sub, ...(typeof claims.email === "string" ? { email: claims.email } : {}) };
    } catch { throw invalid(); }
  }

  private tokens(data: Record<string, unknown>, previous?: Tokens): Tokens {
    const scopes = typeof data.scope === "string" ? data.scope.split(/\s+/).filter(Boolean) : previous?.scopes ?? [];
    const access = typeof data.access_token === "string" ? data.access_token : undefined;
    if (access && (data.token_type !== "Bearer" && data.token_type !== "bearer")) throw new AiError("bad-response", "ChatGPT returned an unsupported token type.");
    if (access && (typeof data.expires_in !== "number" || !Number.isFinite(data.expires_in) || data.expires_in <= 0)) {
      throw new AiError("bad-response", "ChatGPT returned no access-token expiry.");
    }
    return { id: typeof data.id_token === "string" ? data.id_token : previous?.id ?? "", access,
      refresh: typeof data.refresh_token === "string" ? data.refresh_token : previous?.refresh,
      scopes, expiresAt: this.now() + (typeof data.expires_in === "number" ? data.expires_in : 0) * 1000 };
  }

  /** Resolves only after identity validation. IPC starts this in the background and returns status alone. */
  async signIn(options: { profileId?: string; newProfile?: boolean; consent?: boolean } = {}): Promise<void> {
    if (this.pending || this.signingOut) throw new AiError("failed", "A ChatGPT account operation is already running.");
    // IPC starts sign-in in the background, so a failure before the browser opens reaches the user only through status.
    this.locked = undefined;
    if (!this.deps.store.canEncrypt()) throw new AiError("not-configured", this.note = "This Mac cannot encrypt ChatGPT credentials.");
    let saved: SavedState;
    try { saved = this.saved(); } catch (error) { this.locked = error instanceof Error ? error.message : "Could not unlock ChatGPT."; throw error; }
    // A registration whose code exchange failed is reused for the next attempt instead of registering again.
    const retry = saved.profiles.find((p) => p.id === saved.retry && !p.tokens);
    const existing = options.profileId ? saved.profiles.find((p) => p.id === options.profileId)
      : options.newProfile ? retry : this.active() ?? retry;
    if (options.profileId && !existing) throw new AiError("failed", "Choose a saved ChatGPT connection.");
    const controller = new AbortController();
    this.pending = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(300_000)]);
    this.note = undefined;
    try {
      this.save(); // Persist host identity before opening the browser.
      const metadata = await this.metadata(signal);
      const state = randomBytes(32).toString("base64url"), nonce = randomBytes(32).toString("base64url");
      const verifier = randomBytes(64).toString("base64url");
      const listener = await (this.deps.listen ?? loopback)(state, signal);
      const url = new URL(metadata.authorization_endpoint);
      url.search = new URLSearchParams({ client_id: existing?.clientId ?? DYNAMIC_CLIENT,
        ext_agent_host_id: saved.hostId, response_type: "code", redirect_uri: listener.redirectUri,
        scope: SCOPES, resource: RESOURCE, state, nonce, code_challenge_method: "S256", code_challenge: pkceChallenge(verifier),
        ...(!existing ? { agent_name_hint: "Cold Open" } : {}),
        ...(existing?.tokens?.id ? { id_token_hint: existing.tokens.id } : {}),
        ...(existing?.email ? { login_hint: existing.email } : {}), ...(options.consent ? { prompt: "consent" } : {}),
      }).toString();
      await untilAborted(this.deps.openBrowser(url.toString()), signal);
      const params = await listener.callback;
      if (params.has("error")) throw new AiError("unauthorized", "ChatGPT sign-in was declined. You can continue with local casting.");
      const clientId = params.get("client_id") ?? existing?.clientId;
      if (!clientId || clientId === DYNAMIC_CLIENT || (existing && existing.clientId !== clientId)) {
        throw new AiError("unauthorized", "ChatGPT registration did not match. Sign in again.");
      }
      if (!existing && saved.profiles.some((profile) => profile.clientId === clientId)) {
        throw new AiError("unauthorized", "This ChatGPT connection is already saved. Choose it in Settings > AI.");
      }
      const code = params.get("code");
      if (!code) throw new AiError("unauthorized", "ChatGPT returned no authorization code.");
      // Retain a new issued registration even if exchange fails; never activate it before validation.
      const profile = existing ?? { id: randomUUID(), clientId };
      if (!existing) { saved.profiles.push(profile); saved.retry = profile.id; this.save(); }
      const response = await request(this.deps.fetch, metadata.token_endpoint, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code,
          code_verifier: verifier, redirect_uri: listener.redirectUri, resource: RESOURCE }).toString(),
      }, signal);
      if (!response.ok) { await response.body?.cancel(); throw new AiError("unauthorized", "ChatGPT code exchange failed. Sign in again."); }
      const data = await boundedJson(response, signal);
      if (typeof data.id_token !== "string") throw new AiError("unauthorized", "ChatGPT returned no identity token.");
      const identity = await this.identity(data.id_token, clientId, nonce, metadata, signal);
      if (existing?.subject && existing.subject !== identity.subject) {
        throw new AiError("unauthorized", "ChatGPT returned a different account. Add it as a new connection.");
      }
      signal.throwIfAborted();
      const updated: Profile = { ...profile, ...identity, tokens: this.tokens(data), paused: false };
      if (saved.retry === profile.id) delete saved.retry;
      this.renewedAfter401.delete(updated.id);
      saved.profiles[saved.profiles.findIndex((p) => p.id === profile.id)] = updated;
      saved.active = profile.id;
      this.save();
      this.endRequests();
    } catch (error) {
      const failure = connectionError(signal, error);
      this.note = failure.message;
      throw failure;
    } finally {
      controller.abort();
      if (this.pending === controller) this.pending = undefined;
    }
  }

  select(profileId: string): void {
    if (this.pending || this.signingOut) throw new AiError("failed", "Finish the current ChatGPT account operation first.");
    if (!this.saved().profiles.some((p) => p.id === profileId)) throw new AiError("failed", "Unknown ChatGPT connection.");
    // Inference stops at once; a renewal already on the wire settles, since OpenAI may have rotated its refresh token.
    this.session.abort(); this.session = new AbortController();
    this.saved().active = profileId; this.note = undefined; this.save();
  }

  /** The account a request was sent for, by id, or the active one. A response can arrive after a switch. */
  private profile(id?: string): Profile | undefined { return id ? this.saved().profiles.find((p) => p.id === id) : this.active(); }

  pause(profileId?: string): void { const profile = this.profile(profileId); if (profile) { profile.paused = true; this.save(); } }
  resume(): void { const profile = this.active(); if (profile) { profile.paused = false; this.note = undefined; this.save(); } }
  /**
   * Mark the access token used up so the next request renews it; the refresh result decides what happens next.
   * Without a refresh token there is nothing to renew with, so the token is left as it is (false).
   */
  expireAccess(profileId?: string, refusedToken?: string): boolean {
    const profile = this.profile(profileId), tokens = profile?.tokens;
    // A renewal already replaced the refused token: the next request uses the new one, so leave it be.
    if (refusedToken && tokens?.access && tokens.access !== refusedToken) return true;
    // Once per account until a request succeeds: a fresh token that is still refused is not renewed again.
    if (!profile || !tokens?.refresh || this.renewedAfter401.has(profile.id)) return false;
    this.renewedAfter401.add(profile.id);
    tokens.expiresAt = 0; this.save();
    return true;
  }

  /**
   * Replace every token this account holds, and any extra one (the bearer a failing request used), with
   * "[redacted]". A server can echo an opaque token in a header or body that no format filter can recognize.
   */
  redact(text: string, ...extra: (string | undefined)[]): string {
    const held = this.saved().profiles.flatMap((p) => p.tokens ? [p.tokens.access, p.tokens.refresh, p.tokens.id] : []);
    const secrets = [...new Set([...held, ...extra])].filter((t): t is string => typeof t === "string" && t.length >= 8).sort((a, b) => b.length - a.length);
    return secrets.reduce((out, secret) => out.split(secret).join("[redacted]"), text);
  }

  /** A request on the active account succeeded, so a later 401 may renew again. */
  accessWorked(profileId?: string): void { const profile = this.profile(profileId); if (profile) this.renewedAfter401.delete(profile.id); }

  /**
   * Clear one account's tokens: the active one by default, or the account a renewal ran for. A renewal can finish
   * after the writer switched accounts, and must not clear the account switched to.
   */
  invalidate(profile = this.active()): void {
    if (profile) { delete profile.tokens; this.save(); }
    if (profile && profile !== this.active()) return;
    this.note = "ChatGPT credentials expired or were revoked. Continue with ChatGPT to sign in again.";
    this.endRequests();
  }

  async accessToken(signal: AbortSignal): Promise<string> {
    return (await this.access(signal)).token;
  }

  /** The access token and the account it belongs to, so a response is applied to the account that sent it. */
  async access(signal: AbortSignal): Promise<{ token: string; profileId: string }> {
    signal.throwIfAborted();
    // OpenAI: stop requests before revoking. Nothing new uses or renews the tokens while sign-out runs.
    if (this.signingOut) throw new AiError("cancelled", "Signing out of ChatGPT.");
    const profile = this.active(), tokens = profile?.tokens;
    if (profile?.paused) throw new AiError("plan-limit", `${PLAN_LIMIT_MESSAGE}. ChatGPT requests are paused. Check usage, then resume in Settings > AI.`);
    if (!tokens?.access || !tokens.scopes.includes(DIRECT_SCOPE)) throw new AiError("not-configured", "Enable ChatGPT plan usage in Settings > AI.");
    // An unverified set (its identity check still running, or cut off by a crash) is not handed out: callers join
    // the renewal, or start one that ends verified.
    if (tokens.expiresAt > this.now() + 60_000 && !tokens.unverified) return { token: tokens.access, profileId: profile!.id };
    if (!tokens.refresh) { this.invalidate(); throw new AiError("unauthorized", "ChatGPT credentials expired. Sign in again."); }
    // One rotating refresh per account. A cancelled caller does not cancel another caller's renewal.
    const refreshSignal = AbortSignal.any([this.renewal.signal, AbortSignal.timeout(15_000)]);
    if (this.refreshing?.profile.id !== profile!.id) {
      const promise = this.refresh(profile!, refreshSignal).finally(() => {
        if (this.refreshing?.promise === promise) this.refreshing = undefined;
      });
      this.refreshing = { profile: profile!, promise };
    }
    const result = await untilAborted(this.refreshing!.promise, signal);
    signal.throwIfAborted();
    return { token: result, profileId: profile!.id };
  }

  private async refresh(profile: Profile, signal: AbortSignal): Promise<string> {
    try {
      const previous = profile.tokens!;
      const metadata = await this.metadata(signal);
      const response = await request(this.deps.fetch, metadata.token_endpoint, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", client_id: profile.clientId,
          refresh_token: previous.refresh!, resource: RESOURCE }).toString(),
      }, signal);
      if (!response.ok) {
        const data = await boundedJson(response, signal);
        signal.throwIfAborted();
        const code = diagnosticCode(data.error);
        const rid = requestIdOf(response), trace = rid ? `, request ID ${rid}` : "";
        // OpenAI lists these as unusable tokens: clear them and repeat OAuth with the saved client.
        if (TERMINAL_REFRESH.has(code)) {
          this.invalidate(profile);
          throw new AiError("unauthorized", this.redact(`ChatGPT credentials expired or were revoked (HTTP ${response.status}, ${code}${trace}). Continue with ChatGPT to sign in again.`, previous.access, previous.refresh, previous.id));
        }
        // A client problem is not a token problem; the tokens stay until a new sign-in replaces them.
        if (code === "invalid_client") throw new AiError("not-configured", this.redact(`ChatGPT did not recognize Cold Open's registration (HTTP ${response.status}, invalid_client${trace}). Continue with ChatGPT to sign in again.`, previous.refresh));
        throw new AiError("unreachable", this.redact(`ChatGPT could not renew access (HTTP ${response.status}${code ? `, ${code}` : ""}${trace}). Try again later.`, previous.refresh));
      }
      const data = await boundedJson(response, signal);
      const tokens = this.tokens(data, previous);
      if (profile.tokens !== previous) throw new AiError("cancelled", "ChatGPT access changed during renewal.");
      // Saved the moment the answer arrives, before any further check or wait: OpenAI has already rotated the refresh
      // token, so losing this response to a timeout or a key outage would strand the account. Saved even during
      // sign-out, because a rotated refresh token is exactly what sign-out then has to revoke.
      const pending = typeof data.id_token === "string";
      profile.tokens = pending ? { ...tokens, unverified: true } : tokens;
      this.save();
      if (!tokens.access || !tokens.scopes.includes(DIRECT_SCOPE)) {
        this.invalidate(profile);
        throw new AiError("unauthorized", "ChatGPT plan permission changed. Sign in again.");
      }
      if (typeof data.id_token === "string") {
        try {
          const identity = await this.identity(data.id_token, profile.clientId, undefined, metadata, signal);
          if (identity.subject !== profile.subject) throw new AiError("unauthorized", "ChatGPT returned a different account during renewal.");
        } catch (error) {
          // Keys that could not be loaded say nothing about the token; the renewed access stands. A token that fails
          // verification, or a different account, still ends the session (the catch below invalidates).
          if (!(error instanceof AiError && error.code === "unreachable")) throw error;
        }
        if (profile.tokens?.unverified) { delete profile.tokens.unverified; this.save(); }
      }
      return tokens.access;
    } catch (error) {
      if (!signal.aborted && error instanceof AiError && error.code === "unauthorized") this.invalidate(profile);
      throw connectionError(signal, error);
    }
  }

  /**
   * Stop requests, revoke, then clear: the tokens stay saved until revocation is confirmed, so a crash mid-revoke
   * still leaves what is needed to revoke. Network errors and 5xx retry with backoff; if revocation is never
   * confirmed, the tokens are cleared anyway and the writer is pointed to ChatGPT settings.
   */
  async signOut(): Promise<void> {
    if (this.signingOut) return;
    this.signingOut = true;
    this.locked = undefined;
    this.pending?.abort();
    // OpenAI says to stop requests first, so inference ends now; only a renewal is allowed to settle.
    this.session.abort(); this.session = new AbortController();
    // A renewal already on the wire may rotate the refresh token: let it settle (it stops at its own 15 s timeout)
    // before requests are ended, so sign-out revokes the newest token rather than one OpenAI already replaced.
    // A renewal that failed without an answer may still have rotated the token server-side; its replacement can't be
    // revoked from here, so revocation is reported as unconfirmed whatever happens to the old token.
    let renewalLost = false;
    await this.refreshing?.promise.catch((error) => { renewalLost = !(error instanceof AiError && error.code === "unauthorized"); });
    this.endRequests();
    const profile = this.active(), tokens = profile?.tokens;
    let confirmed = !renewalLost;
    try {
      const grants = tokens ? [
        { token: tokens.refresh, hint: "refresh_token" },
        { token: tokens.access, hint: "access_token" },
      ].filter((grant): grant is { token: string; hint: string } => !!grant.token) : [];
      if (profile && grants.length) {
        const signal = AbortSignal.timeout(20_000);
        const metadata = await this.metadata(signal);
        for (const { token, hint } of grants) {
          let revoked = false;
          for (let attempt = 0; attempt < 3 && !revoked; attempt++) {
            if (attempt) await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
            try {
              const response = await request(this.deps.fetch, metadata.revocation_endpoint, {
                method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({ token, token_type_hint: hint, client_id: profile.clientId }).toString(),
              }, signal);
              await response.body?.cancel();
              if (response.ok) revoked = true;
              else if (response.status < 500) break;
            } catch { if (signal.aborted) break; }
          }
          if (!revoked) confirmed = false;
        }
      }
    } catch { confirmed = false; }
    finally {
      if (profile) { delete profile.tokens; profile.paused = false; this.renewedAfter401.delete(profile.id); this.save(); }
      this.note = confirmed ? undefined : "Signed out on this Mac. Remote revocation was not confirmed; disconnect Cold Open in ChatGPT Settings.";
      this.signingOut = false;
    }
  }

  cancelSignIn(): void { this.pending?.abort(); }
  stop(): void { this.cancelSignIn(); this.endRequests(); }
}
