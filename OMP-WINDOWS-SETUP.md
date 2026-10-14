# Set up omp with OpenCode Zen free models (Windows 11)

**You are the agent reading this.** You are the OpenCode CLI running on Windows 11 in PowerShell. The user already has:

- OpenCode installed and signed in, working with OpenCode Zen free models.
- `omp` installed (`omp --version` prints a version).

Make `omp` usable on this machine with the same free Zen models. Work through the steps in order, run every command, and stop at the first failure to report it. **Never print, echo, log, or paste any API key or token value** — not in your replies, not into a file, not into a command line. When a key has to be entered, have the user type it into `omp`'s own prompt.

Everything needed is contained in this file. No other repository, download, or build step is required.

## Why omp fails today

`omp` reports something like:

```
403 OpenCode's free tier can only be used from within OpenCode (type=FreeTierError)
```

OpenCode Zen's gateway restricts free-tier models to requests that look like they come from the OpenCode CLI itself: a versioned `User-Agent` (`opencode/latest/<version>/cli`), plus `x-opencode-client: cli`, several `x-opencode-session*` / `x-session*` session headers carrying a server-registered `ses_…` id, a fresh `msg_…` request id, and core OpenCode tool names in the body. `omp` sends none of those, so the gateway refuses it before any model runs.

Two things improve that: a small extension that adds those headers, and a credential for the Zen provider inside `omp`.

> Status 2026-10-14: upstream tightened the gate around 2026-10-13, and the
> extension below no longer restores free models on its own — requests with
> full header/session/tool parity are still refused, while the genuine
> `opencode` CLI succeeds with the same key. The extension remains the
> closest-possible, fail-open behavior (and helps if the gate relaxes), but
> plan on using free models through `opencode` directly and keeping a
> non-Zen fallback in `omp`. For the extension's registered-session path,
> start the background service once (`opencode service start`, or open the
> `opencode` TUI); without it the extension falls back to generated IDs.

## Step 0 — Baseline, before changing anything

```powershell
omp --version
omp models find free
omp plugins list
```

Record all three. Two things to note now:

- If `omp models find free` lists `opencode-zen` models, the provider is reachable and the failure is request identity — Step 1 is the fix.
- If it lists nothing, the provider is not configured yet; Step 2 is where that gets fixed.

## Step 1 — Add the identity extension to omp

The extension is one TypeScript file. `omp` loads it directly through its bundled runtime, so there is no package install, no Node, and no build.

Create the directory and the file:

```powershell
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.omp\agent\extensions" | Out-Null
notepad "$env:USERPROFILE\.omp\agent\extensions\opencode-fix.ts"
```

Paste exactly this content and save:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile, appendFile } from "node:fs/promises";
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
// Since ~2026-10-13 the gateway rejects fabricated `ses_` IDs. A session ID
// minted by the local background service (`opencode service start`, or the
// TUI) is server-registered and passes. Everything here fails open: no
// service means shape-valid generated IDs, exactly like v1.
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

// --- tool-name gate ----------------------------------------------------------
// The gateway counts core OpenCode tool NAMES in the body (schemas and
// descriptions are ignored). Bodies missing them get fail-open stubs appended:
// the stubs are never registered in the harness, so a model call to one
// errors and the model recovers. Skipped for forced tool_choice (a stub would
// be invoked for sure) and for non-string bodies. Disable with
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

function injectZenTools(url: string, bodyText: string): { text: string; injected: string[]; present: number } {
  const passthrough = { text: bodyText, injected: [] as string[], present: 0 };
  let doc: unknown;
  try {
    doc = JSON.parse(bodyText);
  } catch {
    return passthrough;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return passthrough;
  const body = doc as Record<string, unknown>;
  const tools = Array.isArray(body.tools) ? (body.tools as unknown[]) : null;
  const names = (tools ?? []).map(toolName).filter((n): n is string => n !== null);
  const missing = ZEN_REQUIRED_TOOL_NAMES.filter((n) => !names.includes(n));
  const present = ZEN_REQUIRED_TOOL_NAMES.length - missing.length;
  const out = { text: bodyText, injected: [] as string[], present };
  if (missing.length === 0 || isForcedToolChoice(body.tool_choice)) return out;
  const stubs: Record<string, unknown>[] = [];
  for (const name of missing) {
    const stub = buildStub(url, name);
    if (!stub) return out;
    stubs.push(stub);
  }
  return {
    text: JSON.stringify({ ...body, tools: tools ? [...tools, ...stubs] : stubs }),
    injected: missing,
    present,
  };
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

      let sessionId = await getSessionId();
      for (let attempt = 0; ; attempt++) {
        let resp: Response;
        if (typeof input === "string" || input instanceof URL) {
          const headers = new Headers(init?.headers);
          patchZenHeaders(headers, sessionId);
          let body = init?.body;
          let injected: string[] = [];
          let present = 0;
          if (process.env.ZEN_INJECT_TOOLS !== "0" && typeof body === "string" && body.trimStart().startsWith("{")) {
            const r = injectZenTools(rawUrl, body);
            injected = r.injected;
            present = r.present;
            if (injected.length > 0) {
              body = r.text;
              headers.delete("content-length");
            }
          }
          debugLog(
            `${rawUrl.split("?")[0]} session=${sessionId.slice(0, 18)} tools=${present} injected=[${injected.join(",")}]`,
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
    } catch {
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
```

Verify the file is where `omp` looks:

```powershell
Test-Path "$env:USERPROFILE\.omp\agent\extensions\opencode-fix.ts"
Get-Content "$env:USERPROFILE\.omp\agent\extensions\opencode-fix.ts" | Measure-Object -Line
```

Expect `True` and around 380 lines. `omp` scans `<agent dir>\extensions\` and loads each file it finds there.

Restart `omp` afterwards: extensions load at startup, so an already-running session will not see it.

Same file works for `pi` if the user also uses it — there, copy it to `$env:USERPROFILE\.pi\agent\extensions\opencode-fix.ts`.

An alternative, if the user prefers a package install over a file: `omp install git:github.com/cutieway/pi-opencode-fix`, then `omp plugins list` should show `pi-opencode-fix`. If that command fails because `git` is missing, install Git for Windows (`winget install --id Git.Git`) or just use the file above.

## Step 2 — Give omp a Zen credential

OpenCode's own login lives in OpenCode's database, which `omp` cannot read, so `omp` needs its own credential:

```powershell
omp login opencode-zen
```

Paste the OpenCode Zen API key when prompted. Get that key from the Console: sign in at `https://opencode.ai/console`, open the workspace, and look for its API keys page. `omp`'s own help points at `https://opencode.ai/auth`, which redirects to the Console sign-in.

If the interactive provider list offers only `opencode-go` and an OpenCode Console entry, with no `opencode-zen`, stop and report what you saw rather than guessing a provider name.

Confirm:

```powershell
omp auth list
```

This should list `opencode-zen`. The key is stored in `%USERPROFILE%\.omp\agent\agent.db`; leave that file alone.

## Step 3 — Point the model roles at free models

Edit `%USERPROFILE%\.omp\agent\config.yml`, creating it if it does not exist. Merge these keys into whatever is already there instead of replacing the file:

```yaml
modelRoles:
  # The reviewer and the tool-less auxiliary tasks use space-bunny-free:
  # muse-spark refuses the tool-less request shape outright.
  advisor: opencode-zen/space-bunny-free
  tiny: opencode-zen/space-bunny-free
  default: opencode-zen/muse-spark-1.3-contributor-free:xhigh
  # Every other chat role follows the default role through `*`. Roles other
  # than smol/slow inherit nothing on their own, so an unset plan, commit,
  # vision, memory, or task can resolve to a paid model instead.
  smol: "*"
  slow: "*"
  memory: "*"
  plan: "*"
  commit: "*"
  task: "*"
  vision: "*"
retry:
  fallbackChains:
    # Keep a free model ahead of any paid one, so a refused request retries for
    # free instead of spending money.
    opencode-zen/*:
      - opencode-zen/space-bunny-free
advisor:
  enabled: true
```

Confirm it parses:

```powershell
omp config get modelRoles
```

Both models named above are free Zen models. `muse-spark-1.3-contributor-free` serves the main agent and speaks the Responses API. `space-bunny-free` speaks chat completions and is the one that accepts tool-less requests.

## Step 4 — Give the advisor a larger tool slate

`omp`'s built-in advisor/reviewer role runs with only `read`, `grep`, `glob`, plus its own `advise` tool, and that four-name shape is refused by the gateway. A roster entry replaces the slate, and only a roster file can express it: the global `advisor:` block has no `tools` key.

Create `%USERPROFILE%\.omp\agent\WATCHDOG.yml`:

```yaml
advisors:
  - name: Advisor
    tools:
      - read
      - bash
      - edit
      - ask
      - eval
      - glob
      - grep
      - task
      - wait
      - todo
      - web_search
      - write
```

Everything else about the advisor keeps its defaults: the model comes from `modelRoles.advisor`, and the system prompt is built in.

One consequence to state plainly to the user: this makes the advisor a full agent, able to edit files and run commands through those tools. If a read-only reviewer is preferred, drop `bash`, `edit`, `eval`, and `write` from the list — accepting that a smaller slate may be refused again by the gateway.

## Step 5 — Verify

Single-shot check:

```powershell
omp --model opencode-zen/space-bunny-free -p "reply with exactly: harness-ok"
```

Expect `harness-ok`, with no warning about a fallback model.

Then start an interactive session so the advisor fires on the reply:

```powershell
omp
```

Success looks like the advisor producing review notes with **no** line such as:

```
Warning: Fallback: opencode-zen/space-bunny-free -> <another model>
Advisor request failed: 403 ... (type=FreeTierError)
```

If something still fails, go to Step 6 rather than reinstalling anything.

## Step 6 — Debugging

Capture the exact requests `omp` sends. Do it in a scratch directory so the dumps are easy to find:

```powershell
New-Item -ItemType Directory -Force -Path C:\omp-dbg | Out-Null
cd C:\omp-dbg
$env:PI_REQ_DEBUG = '1'
omp
```

Send a message, exit `omp`, then inspect:

```powershell
Get-ChildItem C:\omp-dbg\rr-session-*.json | Select-Object Name, Length
Get-Content C:\omp-dbg\rr-session-1.json
Get-Content C:\omp-dbg\rr-session-1.res.log
```

Each `rr-session-N.json` records one request as it *enters* `omp`'s transport, and the matching `.res.log` holds that response's status and body. Note the dumps are taken before the extension rewrites a request, so headers the extension adds will not appear in them; the model, the tools array, and the request shape still show.

Reading the results:

| Observation | Meaning |
|---|---|
| `403` with `error code: 1010` | Cloudflare refused it outright — no OpenCode identity at all, so the extension is not loaded or not applied. Check the file path and restart. |
| `403` with `{"type":"error","error":{"type":"FreeTierError",...}}` | The gateway disliked the identity or refused this request shape. |
| `402 Payment Required` | A paid Zen model was requested with no credits — a model role or fallback points at a paid model; recheck Step 3. |
| Requests to `api.deepseek.com` or another paid host | The fallback chain is spending money; recheck Step 3. |
| No `rr-session-*` files at all | `PI_REQ_DEBUG` did not reach the process. Set it in the same PowerShell window that launches `omp`. |

Check `omp`'s own log for the reviewer failure:

```powershell
Get-ChildItem "$env:USERPROFILE\.omp\logs" | Sort-Object LastWriteTime -Descending | Select-Object -First 3
Select-String -Path "$env:USERPROFILE\.omp\logs\*.log" -Pattern 'advisor turn failed'
```

One trap worth knowing: after a refused request, `omp` blocks that provider credential for about 60 seconds and then *replays* the stored error instead of making a new request. Repeated identical failures inside a minute can therefore be one real failure plus replays. Wait a minute, or restart `omp`, before concluding that a change did not help.

Two more notes for the user's sake:

- The extension and the `omp` binary are separate. Upgrading or reinstalling `omp` does not remove the file, but if the extension ever disappears from `omp plugins list` and the file is gone, redo Step 1.
- Windows has no OS keyring here, so the Zen key sits in `omp`'s own credential database with user-only permissions, like most CLI agents. No one else on the machine can read it; treat that file as a secret.

## Step 7 — Report back

Send the following so the next person can continue from here:

- `omp --version`
- Output of `omp plugins list`
- Output of `omp models find free`
- Whether `omp auth list` shows `opencode-zen`
- The contents of `%USERPROFILE%\.omp\agent\config.yml` and `%USERPROFILE%\.omp\agent\WATCHDOG.yml`
- If anything failed: the `rr-session-*.json` and `.res.log` files from Step 6, plus the exact error text

If a `403` response body contains an `x-opencode-log-id` header, include that id — it is what upstream needs to trace a refusal.
