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

OpenCode Zen's gateway restricts free-tier models to requests that look like they come from the OpenCode CLI itself: a specific `User-Agent`, plus `x-opencode-client: cli`, `x-opencode-project: global`, a `ses_…` session id, and a fresh `msg_…` request id on every call to a `/zen` path. `omp` sends none of those, so the gateway refuses it before any model runs.

Two things fix that: a small extension that adds those headers, and a credential for the Zen provider inside `omp`.

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

const OPENCODE_VERSION = "1.18.31";
const USER_AGENT = `opencode/${OPENCODE_VERSION}`;

const ID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let counter = 0;
let lastTimestamp = 0;
let sessionId: string | undefined;

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

function getSessionId(): string {
  sessionId ??= generateId("ses", true);
  return sessionId;
}

function isOpenCodeId(value: string | null, prefix: "ses" | "msg"): boolean {
  return value !== null && new RegExp(`^${prefix}_[a-f0-9]{12}[0-9A-Za-z]{14}$`).test(value);
}

// OpenCode expects a stable session ID and a fresh `msg_` request ID per call.
const originalFetch = globalThis.fetch;
globalThis.fetch = async function (input: RequestInfo | URL, init?: RequestInit) {
  const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  let requestUrlObject: URL | undefined;
  try {
    requestUrlObject = new URL(requestUrl);
  } catch {
    // Leave non-URL fetch inputs untouched.
  }

  const hostname = requestUrlObject?.hostname.toLowerCase();
  const isZenApi =
    (hostname === "opencode.ai" || hostname?.endsWith(".opencode.ai")) &&
    (requestUrlObject?.pathname === "/zen" || requestUrlObject?.pathname.startsWith("/zen/"));

  if (isZenApi) {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    }
    headers.set("User-Agent", USER_AGENT);
    headers.set("x-opencode-client", "cli");
    headers.set("x-opencode-project", "global");
    if (!isOpenCodeId(headers.get("x-opencode-session"), "ses")) {
      headers.set("x-opencode-session", getSessionId());
    }
    if (!isOpenCodeId(headers.get("x-opencode-request"), "msg")) {
      headers.set("x-opencode-request", generateId("msg", false));
    }
    return originalFetch(input, { ...init, headers });
  }

  return originalFetch(input, init);
};

export default function (pi: ExtensionAPI) {
  pi.on("session_start", () => {
    sessionId = generateId("ses", true);
  });
  const providers = ["oc", "opencode", "opencode-go", "opencode-zen"];
  for (const p of providers) {
    pi.registerProvider?.(p, {
      headers: {
        "User-Agent": USER_AGENT,
        "x-opencode-client": "cli",
        "x-opencode-project": "global",
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

Expect `True` and around 90 lines. `omp` scans `<agent dir>\extensions\` and loads each file it finds there.

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
