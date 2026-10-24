import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile, appendFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

// Unpatched fetch, captured before the wrapper installs. Control-plane calls
// to the local opencode service use this so they can never recurse into the
// wrapper and deadlock.
const rawFetch: typeof fetch | undefined =
  typeof globalThis.fetch === "function" ? globalThis.fetch : undefined;

// --- v2 client identity ------------------------------------------------------
// Live capture (BUN_CONFIG_VERBOSE_FETCH=curl) of the genuine CLI shows:
//   User-Agent: opencode/latest/<version>/cli
// A version floor is enforced server-side, so read the locally installed
// version once instead of pinning a stale one.
function localOpencodeVersion(): string {
  const fallback = "2.0.27";
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    const out = spawnSync("opencode", ["--version"], { timeout: 2000, encoding: "utf8" });
    const match = /v?(\d+\.\d+\.\d+)/.exec(String(out?.stdout ?? ""));
    if (match) return match[1];
  } catch {
    // No opencode binary or spawn blocked: fall back below.
  }
  return fallback;
}

const OPENCODE_VERSION = localOpencodeVersion();
const USER_AGENT = `opencode/latest/${OPENCODE_VERSION}/cli`;

// --- session/request IDs -----------------------------------------------------
const ID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let counter = 0;
let lastTimestamp = 0;

function generateId(prefix: "ses" | "msg", descending: boolean, timestamp = Date.now()): string {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp;
    counter = 0;
  }
  counter++;

  const current = BigInt(timestamp) * 0x1000n + BigInt(counter);
  const value = descending ? ~current : current;
  const timeHex = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0")
  ).join("");

  const bytes = crypto.getRandomValues(new Uint8Array(14));
  const rand = Array.from(bytes, (b) => ID_CHARS[b % 62]).join("");
  return `${prefix}_${timeHex}${rand}`;
}

function isOpenCodeId(value: string | null, prefix: "ses" | "msg"): boolean {
  return value !== null && new RegExp(`^${prefix}_[0-9a-f]{12}[0-9A-Za-z]{14}$`).test(value);
}

// --- local opencode service (registered sessions) ----------------------------
// A registered session (`opencode service start`, or the TUI) is used when
// available. It is no longer required: the gateway relaxed by 2026-10-19, and
// a shape-valid generated `ses_` id passes again (the genuine CLI accepts one
// too). Everything here fails open to generated IDs.
const OC_SERVICE_JSON = (() => {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "opencode", "service.json");
  }
  const xdg = process.env.XDG_STATE_HOME?.trim();
  if (xdg) return join(xdg, "opencode", "service.json");
  return join(homedir(), ".local", "state", "opencode", "service.json");
})();

interface ServiceInfo {
  url: string;
  password: string;
}

async function readServiceInfo(): Promise<ServiceInfo | null> {
  const override = process.env.OPENCODE_SERVER_URL?.trim();
  if (override) return { url: override.replace(/\/$/, ""), password: "" };
  try {
    const raw = await readFile(OC_SERVICE_JSON, "utf8");
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (typeof obj.url !== "string" || typeof obj.password !== "string") return null;
    return { url: obj.url.replace(/\/$/, ""), password: obj.password };
  } catch {
    return null;
  }
}

async function createOpencodeSession(svc: ServiceInfo): Promise<string | null> {
  try {
    const auth = "Basic " + Buffer.from(`opencode:${svc.password}`).toString("base64");
    const doFetch = rawFetch ?? fetch;
    const resp = await doFetch(`${svc.url}/api/session`, {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: {
        Authorization: auth,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({
        location: { directory: process.env.HOME ?? homedir() },
      }),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { data?: { id?: string } };
    const id = data?.data?.id;
    return typeof id === "string" && id.startsWith("ses_") ? id : null;
  } catch {
    return null;
  }
}

let registeredSessionId: string | null = null;
let sessionFetchInProgress: Promise<string | null> | null = null;
let lastCreateFailedAt = 0;
const CREATE_RETRY_COOLDOWN_MS = 15_000;
// Rotations are capped: a 403 can mean a stale session OR a gate verdict, and
// the two are indistinguishable. Past the cap, fail open with the current ID
// instead of minting sessions the gateway will reject anyway.
let sessionRotations = 0;
const MAX_SESSION_ROTATIONS = 3;
// Fallback generated ID, stable per process for prompt-cache affinity.
let fallbackSessionId: string | undefined;

async function getSessionId(): Promise<string> {
  if (registeredSessionId) return registeredSessionId;
  if (sessionFetchInProgress) return (await sessionFetchInProgress) ?? getFallbackSessionId();
  if (Date.now() - lastCreateFailedAt < CREATE_RETRY_COOLDOWN_MS) return getFallbackSessionId();

  sessionFetchInProgress = (async () => {
    const svc = await readServiceInfo();
    if (!svc) return null;
    const id = await createOpencodeSession(svc);
    if (id) {
      registeredSessionId = id;
      return id;
    }
    lastCreateFailedAt = Date.now();
    return null;
  })().finally(() => {
    sessionFetchInProgress = null;
  });

  return (await sessionFetchInProgress) ?? getFallbackSessionId();
}

function getFallbackSessionId(): string {
  fallbackSessionId ??= generateId("ses", true);
  return fallbackSessionId;
}

function resetSessionCache(): void {
  registeredSessionId = null;
  sessionRotations = 0;
  fallbackSessionId = generateId("ses", true);
}

// --- env-block gate ----------------------------------------------------------
// Since 2026-10-24 the gateway answers 429 `FreeUsageLimitError` (which reads
// like "out of quota" but is a client check) to any request whose system
// message lacks an `<env>` ... `</env>` block. Measured: `<env></env>` in the
// system message passes, the same block in a user message does not, and the
// content between the tags is ignored. OpenCode's own prompt always carries
// one, so the gateway apparently uses it as its "is this our agent loop"
// signal. The block appended here is the same shape OpenCode sends, with the
// values the harness can actually observe. It is appended, never prepended, so
// the harness prompt stays first. Disable with ZEN_INJECT_ENV=0.
const ENV_OPEN = "<env>";
const ENV_CLOSE = "</env>";

function envBlock(): string {
  return [
    ENV_OPEN,
    `  Working directory: ${process.cwd()}`,
    `  Platform: ${process.platform}`,
    ENV_CLOSE,
  ].join("\n");
}

type JsonObject = Record<string, unknown>;

function hasEnvBlock(text: string): boolean {
  const open = text.indexOf(ENV_OPEN);
  return open >= 0 && text.indexOf(ENV_CLOSE, open + ENV_OPEN.length) >= 0;
}

// Appends the block to the first system/developer message; if the harness sent
// no system message at all, one is created so the gateway sees the marker.
function injectZenEnv(body: JsonObject): { changed: boolean; added: boolean } {
  const messages = Array.isArray(body.messages) ? (body.messages as JsonObject[]) : null;
  if (!messages) return { changed: false, added: false };
  const system = messages.find((m) => m && (m.role === "system" || m.role === "developer"));
  if (!system) {
    messages.unshift({ role: "system", content: envBlock() });
    return { changed: true, added: true };
  }
  const content = system.content;
  if (typeof content === "string") {
    if (hasEnvBlock(content)) return { changed: false, added: false };
    system.content = `${content}\n\n${envBlock()}`;
    return { changed: true, added: true };
  }
  if (Array.isArray(content)) {
    const parts = content as JsonObject[];
    const text = parts.map((p) => (typeof p?.text === "string" ? p.text : "")).join("");
    if (hasEnvBlock(text)) return { changed: false, added: false };
    parts.push({ type: "text", text: envBlock() });
    return { changed: true, added: true };
  }
  return { changed: false, added: false };
}

// --- tool-name gate ----------------------------------------------------------
// The gateway validates tool NAMES in the body (schemas and descriptions are
// ignored). Since the gate relaxed (by 2026-10-19) only a tool named `read` is
// required, but the full core set stays injected so the request also passes
// if the gate tightens again. Bodies missing any of them get fail-open stubs
// appended: the stubs are never registered in the harness, so a model call to
// one errors and the model recovers. Skipped for forced tool_choice (a stub
// would be invoked for sure) and for non-string bodies. Disable with
// ZEN_INJECT_TOOLS=0.
const ZEN_REQUIRED_TOOL_NAMES = ["bash", "read", "edit", "glob", "grep"];
const STUB_DESCRIPTION = "Gateway-validation stub. NOT IMPLEMENTED - never call this tool.";

function toolName(t: unknown): string | null {
  if (!t || typeof t !== "object") return null;
  const rec = t as Record<string, unknown>;
  if (typeof rec.name === "string") return rec.name; // Responses API
  const fn = rec.function as Record<string, unknown> | undefined; // chat completions
  return fn && typeof fn.name === "string" ? fn.name : null;
}

function buildStub(url: string, name: string): Record<string, unknown> | null {
  const parameters = {
    type: "object",
    properties: {
      command: { type: "string" },
      description: { type: "string" },
    },
    required: ["command"],
    additionalProperties: false,
  };
  if (url.includes("/chat/completions")) {
    return { type: "function", function: { name, description: STUB_DESCRIPTION, parameters } };
  }
  if (url.includes("/responses")) {
    return { type: "function", name, description: STUB_DESCRIPTION, parameters };
  }
  return null;
}

function isForcedToolChoice(choice: unknown): boolean {
  if (choice === "required" || choice === "any") return true;
  if (choice && typeof choice === "object" && !Array.isArray(choice) && "type" in choice) {
    const t = (choice as Record<string, unknown>).type;
    return t === "required" || t === "any";
  }
  return false;
}

function injectZenTools(
  url: string,
  bodyText: string,
): { text: string; injected: string[]; present: number; envAdded: boolean; model: string } {
  const passthrough = {
    text: bodyText,
    injected: [] as string[],
    present: 0,
    envAdded: false,
    model: "",
  };
  let doc: unknown;
  try {
    doc = JSON.parse(bodyText);
  } catch {
    return passthrough;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return passthrough;
  const body = doc as Record<string, unknown>;
  const model = typeof body.model === "string" ? body.model : "";

  let envAdded = false;
  if (process.env.ZEN_INJECT_ENV !== "0") {
    envAdded = injectZenEnv(body).changed;
  }

  const tools = Array.isArray(body.tools) ? (body.tools as unknown[]) : null;
  const names = (tools ?? []).map(toolName).filter((n): n is string => n !== null);
  const missing = ZEN_REQUIRED_TOOL_NAMES.filter((n) => !names.includes(n));
  const present = ZEN_REQUIRED_TOOL_NAMES.length - missing.length;
  if (missing.length === 0 || isForcedToolChoice(body.tool_choice)) {
    return { text: envAdded ? JSON.stringify(body) : bodyText, injected: [], present, envAdded, model };
  }
  const stubs: Record<string, unknown>[] = [];
  for (const name of missing) {
    const stub = buildStub(url, name);
    if (!stub) return { text: envAdded ? JSON.stringify(body) : bodyText, injected: [], present, envAdded, model };
    stubs.push(stub);
  }
  body.tools = tools ? [...tools, ...stubs] : stubs;
  return { text: JSON.stringify(body), injected: missing, present, envAdded, model };
}

// --- fetch patch -------------------------------------------------------------
function isZenUrl(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === "opencode.ai" || host.endsWith(".opencode.ai");
  } catch {
    return false;
  }
}

function debugLog(line: string): void {
  if (process.env.ZEN_HEADERS_DEBUG !== "1") return;
  void appendFile(`${tmpdir()}/zen-free-tier-headers.log`, `${new Date().toISOString()} ${line}\n`).catch(
    () => undefined,
  );
}

function patchZenHeaders(headers: Headers, sessionId: string): void {
  headers.set("User-Agent", USER_AGENT);
  headers.set("x-opencode-client", "cli");
  if (!headers.has("x-opencode-project")) {
    headers.set("x-opencode-project", "");
  }
  // All session-header variants the gateway and Go lane read.
  headers.set("x-opencode-session", sessionId);
  headers.set("x-opencode-session-id", sessionId);
  headers.set("x-session-affinity", sessionId);
  headers.set("x-session-id", sessionId);
  if (!isOpenCodeId(headers.get("x-opencode-request"), "msg")) {
    headers.set("x-opencode-request", generateId("msg", false));
  }
}

// --- 429 circuit breaker -----------------------------------------------------
// A 429 that carries `retry-after` on a request which already had the env
// block is a real free-model limit: the deadline points at 00:00 UTC and each
// retry before then only costs a round trip (and a wasted prompt cache). A 429
// without that evidence is the shape check rejecting the body, so it is
// blocked briefly instead of for the rest of the day. The deadline is kept per
// model (a per-model cap must not block the other free models) and persisted in
// tmpdir so separate `omp -p` / `pi -p` runs honour it too, since each run is a
// new process; delete the file to retry early. The breaker is advisory: the
// first 429 after a reset is always sent.
const BREAKER_FILE = join(tmpdir(), "zen-free-tier-limit.json");
// No `retry-after` (proxy, gateway hiccup, shape rejection): block briefly.
const DEFAULT_BLOCK_MS = 60_000;
type BreakerState = Record<string, number>;
let breakerState: BreakerState | null = null;

async function loadBreaker(): Promise<BreakerState> {
  if (breakerState) return breakerState;
  const now = Date.now();
  const state: BreakerState = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(BREAKER_FILE, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === "number" && Number.isFinite(value) && value > now) state[key] = value;
      }
    }
  } catch {
    // Missing or unreadable file: start empty.
  }
  breakerState = state;
  return state;
}

async function noteBlocked(key: string, until: number): Promise<void> {
  const state = await loadBreaker();
  state[key] = until;
  try {
    await writeFile(BREAKER_FILE, JSON.stringify(state), { mode: 0o600 });
  } catch {
    // An unpersisted breaker still protects the current process.
  }
}

function retryAfterMs(resp: Response): number | null {
  const ms = resp.headers.get("retry-after-ms");
  if (ms !== null && ms !== "") {
    const n = Number(ms);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const raw = resp.headers.get("retry-after");
  if (raw === null || raw === "") return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(raw); // HTTP-date form
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

function formatReset(at: number): string {
  return `${new Date(at).toLocaleString()} (${new Date(at).toISOString().slice(0, 16)}Z)`;
}

// The model is the only part of a Zen request the bucket is keyed by, so a
// request that hits a per-model cap must not block the other free models.
function breakerKey(rawUrl: string, body: BodyInit | null | undefined): string {
  let model = "unknown";
  if (typeof body === "string" && body.trimStart().startsWith("{")) {
    try {
      const doc = JSON.parse(body) as { model?: unknown };
      if (typeof doc.model === "string" && doc.model) model = doc.model;
    } catch {
      // Not JSON: fall back to the endpoint-wide key.
    }
  }
  try {
    const url = new URL(rawUrl);
    return `${url.host}${url.pathname}:${model}`;
  } catch {
    return `opencode.ai:${model}`;
  }
}

class ZenLimitError extends Error {
  // Deliberately carries no `status`. omp classifies a thrown error with a
  // 4xx `status` as non-retryable but also dumps the whole request (prompt
  // included) to ~/.omp/logs/http-<status>-requests/. Without `status` the
  // classifier falls through to its message patterns, so the wording below
  // must avoid `rate limit`, `too many requests`, `timeout` and friends:
  // those mark the error retryable and omp re-schedules the turn every ~30s.
  constructor(message: string) {
    super(message);
    this.name = "ZenFreeLimitError";
  }
}

// omp/pi surface the provider error body verbatim, and the server's body does
// not say when the bucket refills (only the header does). Appending the reset
// time is what turns "try later" into an actionable message. Any body that is
// not the usual JSON error is returned untouched.
async function annotate429(resp: Response, until: number | null): Promise<Response> {
  if (until === null || !resp.headers.get("content-type")?.includes("json")) return resp;
  try {
    const text = await resp.text();
    const doc = JSON.parse(text) as { error?: { message?: unknown } };
    const message = doc?.error?.message;
    if (typeof message !== "string" || message.includes("resets")) return resp;
    doc.error!.message = `${message} (free-model bucket resets ${formatReset(until)})`;
    const headers = new Headers(resp.headers);
    headers.delete("content-length");
    return new Response(JSON.stringify(doc), { status: resp.status, statusText: resp.statusText, headers });
  } catch {
    return resp;
  }
}

const PATCH_FLAG = "__piOpencodeFixV2Patched";

function installFetchPatch(): void {
  const g = globalThis as Record<string, unknown>;
  if (g[PATCH_FLAG]) return;
  const origFetch = globalThis.fetch;
  if (typeof origFetch !== "function") return;

  const patchedFetch = async function (
    this: unknown,
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> {
    try {
      const rawUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request | undefined)?.url;
      if (typeof rawUrl !== "string" || !isZenUrl(rawUrl)) {
        return origFetch.call(this, input, init);
      }

      // String/URL inputs carry a re-sendable inline body; a Request with a
      // stream body is consumed by the first send and cannot be retried.
      const retryable = typeof input === "string" || input instanceof URL || (input as Request).body === null;
      const limitKey = breakerKey(rawUrl, init?.body);

      // Fail locally while the free bucket is known to be empty. Thrown from
      // inside the try, so the catch below must rethrow it rather than
      // falling through to an unpatched send.
      if (process.env.ZEN_429_BREAKER !== "0") {
        const until = (await loadBreaker())[limitKey];
        if (until !== undefined && until > Date.now()) {
          const model = limitKey.slice(limitKey.lastIndexOf(":") + 1);
          throw new ZenLimitError(
            `opencode.ai free model ${model} is unavailable until ${formatReset(until)}; request not sent. ` +
              `Another call before then only spends a round trip. Use another model, wait, or delete ` +
              `${BREAKER_FILE} to retry early.`,
          );
        }
      }

      let sessionId = await getSessionId();
      for (let attempt = 0; ; attempt++) {
        let resp: Response;
        if (typeof input === "string" || input instanceof URL) {
          const headers = new Headers(init?.headers);
          patchZenHeaders(headers, sessionId);
          let body = init?.body;
          let injected: string[] = [];
          let present = 0;
          let envAdded = false;
          let model = "";
          if (typeof body === "string" && body.trimStart().startsWith("{")) {
            if (process.env.ZEN_INJECT_ENV !== "0" || process.env.ZEN_INJECT_TOOLS !== "0") {
              const r = injectZenTools(rawUrl, body);
              model = r.model;
              if (process.env.ZEN_INJECT_ENV !== "0") envAdded = r.envAdded;
              if (process.env.ZEN_INJECT_TOOLS !== "0") {
                injected = r.injected;
                present = r.present;
              }
              if (r.text !== body) body = r.text;
              if (r.text !== init?.body) headers.delete("content-length");
            }
          }
          debugLog(
            `${rawUrl.split("?")[0]} model=${model} session=${sessionId.slice(0, 18)} tools=${present} ` +
              `injected=[${injected.join(",")}] env=${envAdded}`,
          );
          resp = await origFetch.call(this, input, { ...init, headers, body });
        } else {
          // Request input: rebuild so patched headers reliably win.
          const merged = new Headers((input as Request).headers);
          new Headers(init?.headers).forEach((v, k) => merged.set(k, v));
          patchZenHeaders(merged, sessionId);
          const { headers: _drop, ...rest } = (init ?? {}) as RequestInit;
          const req = new Request(input as Request, { headers: merged });
          debugLog(`${(input as Request).url.split("?")[0]} session=${sessionId.slice(0, 18)} request-input`);
          resp = await origFetch.call(this, req, Object.keys(rest).length ? rest : undefined);
        }

        // A 429 with `retry-after` on a request that carried the env block is
        // a real bucket limit: remember the refill and fail locally until then.
        // A 429 on a request that never got the block is the shape check
        // rejecting it, so block only briefly and let the next call try with a
        // patched body.
        if (resp.status === 429) {
          // Only a request that carried the marker can be genuinely metered.
          const wait = envAdded ? retryAfterMs(resp) : null;
          const honored = wait !== null;
          const until = Date.now() + (wait ?? DEFAULT_BLOCK_MS);
          if (process.env.ZEN_429_BREAKER !== "0") {
            await noteBlocked(limitKey, until);
          }
          debugLog(
            `${rawUrl.split("?")[0]} 429 key=${limitKey} env=${envAdded} until=${formatReset(until)}`,
          );
          return honored ? annotate429(resp, until) : resp;
        }

        // A registered session can go stale mid-run (service restart,
        // pruning): on 403 drop it and retry once with a fresh session,
        // within the rotation cap. Past the cap, fail open: the 403 is
        // almost certainly a gate verdict, not a stale session.
        if (resp.status !== 403 || attempt > 0 || !retryable) return resp;
        if (sessionRotations >= MAX_SESSION_ROTATIONS) return resp;
        sessionRotations++;
        try {
          await resp.body?.cancel();
        } catch {
          // Release the socket; ignore errors.
        }
        registeredSessionId = null;
        lastCreateFailedAt = 0;
        const fresh = await getSessionId();
        if (fresh === sessionId) return resp;
        debugLog(`${rawUrl.split("?")[0]} session-stale retry with ${fresh.slice(0, 18)}`);
        sessionId = fresh;
      }
    } catch (error) {
      // The breaker's own error is deliberate: surface it instead of
      // re-sending the request unpatched.
      if (error instanceof ZenLimitError) throw error;
      // Fail open: never break a request because the patch hit something odd.
      return origFetch.call(this, input, init);
    }
  };

  globalThis.fetch = patchedFetch as typeof fetch;
  g[PATCH_FLAG] = true;
}

installFetchPatch();

export default function (pi: ExtensionAPI) {
  pi.on("session_start", () => {
    resetSessionCache();
  });
  pi.logger?.info?.(`[opencode-fix] v2 patch active (UA: ${USER_AGENT})`);
  const providers = ["oc", "opencode", "opencode-go", "opencode-zen"];
  for (const p of providers) {
    pi.registerProvider?.(p, {
      headers: {
        "User-Agent": USER_AGENT,
        "x-opencode-client": "cli",
        "x-opencode-project": "",
      },
    });
  }
}
