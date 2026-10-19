# pi-opencode-fix

Extension package for **Pi Coding Agent (`pi`)** and **Oh My Pi (`omp`)** that fixes HTTP 403 `FreeTierError` and HTTP 429 `FreeUsageLimitError` when calling OpenCode Zen models, whose free-model catalog changes over time.

## Problem

When using OpenCode models with `pi` or `omp`, requests may fail with:
```text
403: {"type":"FreeTierError","message":"Error from provider (Console): OpenCode's free tier can only be used from within OpenCode"}
```
or:
```text
429: {"type":"FreeUsageLimitError","message":"Error from provider (Console): Rate limit exceeded. Please try again later."}
```
This occurs because the OpenCode Zen API gateway (`https://opencode.ai/zen/v1`)
accepts free-tier requests only from clients that look like the OpenCode CLI:
an OpenCode `User-Agent` at version 1.18.0 or newer, a shape-valid
`x-opencode-session` id, at least one tool named `read`, and a streaming
body. `pi`/`omp` send none of those, so the gateway refuses them before any
model runs.

## Status (2026-10-19): working again — the gateway relaxed

The stricter gate described below was live from ~2026-10-13 through at least
2026-10-15. Sometime between 2026-10-15 and 2026-10-19 the Zen gateway
relaxed it. The fix that was refused on 2026-10-15 is the same code that
answers `200` today; this release (1.3.1) only updates docs and comments and
changes the relay's default model. Verified live on 2026-10-19
against `https://opencode.ai/zen/v1/chat/completions` with
`deepseek-v4.1-flash-free`, `mimo-v2.6-flash-free`, and `space-bunny-free`:

| Request | Result |
|---|---|
| `User-Agent: opencode/latest/2.0.32/cli` + shape-valid `x-opencode-session` + `read` tool + `stream: true` | 200 |
| Missing UA or session header | 403 `FreeTierError` |
| UA version below 1.18.0 (e.g. `1.17.99`) | 426 `UpgradeRequired` |
| UA `opencode/2.0.32` (no `/latest/.../cli` suffix) | 200 |
| UA `opencode/latest/2.0.32/cli/` (trailing slash) | 403 |
| `stream: false` | 403 |
| Tools: `read` only | 200 |
| Tools: `bash`, `edit`, `glob`, `grep`, `write`, `task`, `web_search`, … without `read` | 403 |
| `read` + any `tool_choice` (`none` / `auto` / `required`) | 200 |
| `/zen/v1/responses` | 400 `ModelProtocolUnsupported` for free models |

The current rule is therefore: an OpenCode `User-Agent` at version 1.18.0 or
newer, one shape-valid session ID, at least one tool named exactly `read`,
and a streaming request. A server-registered session is no longer required;
generated shape-valid IDs pass, and the genuine CLI accepts them too.

`omp` 18.12.2 with this extension now answers through Zen directly, including
the advisor's default `advise`/`read`/`glob`/`grep` slate. The
`WATCHDOG.yml` tool-roster workaround from the strict period is no longer
needed; keeping it still works but turns the advisor into a full agent.

The extension is still required. Verified on 2026-10-19 with
`omp --no-extensions`: both `deepseek-v4.1-flash-free` and
`space-bunny-free` returned 403 `FreeTierError`, and the printed answer came
from the `retry.fallbackChains` fallback to `deepseek/deepseek-v4-flash-vision-exp`.
Unpatched `pi`/`omp` requests lack the identity headers and the `read` tool
name, so they are refused.

## Solution

This extension injects OpenCode CLI identity headers for requests to
`opencode.ai` and its subdomains. It uses the v2 user agent
(`opencode/latest/<local-version>/cli`, read from the installed `opencode`
binary), a server-registered session ID from the local opencode background
service when available (falling back to a shape-valid generated ID), all five
session-header variants, and a fresh `msg_` request ID per call. String JSON
bodies missing core OpenCode tool names get fail-open stubs appended
(skipped for forced `tool_choice`); see `ZEN_INJECT_TOOLS=0` below to
disable. It also configures static provider headers for `opencode`,
`opencode-go`, `opencode-zen`, and `oc` in `pi` / `omp`.

Prerequisites for the registered-session path: `opencode` v2 installed and
its background service running (`opencode service start`, or open the TUI
once). Without the service the extension fails open to generated IDs.

Env:

- `ZEN_INJECT_TOOLS=0` — disable tool-stub injection (headers still patched)
- `ZEN_HEADERS_DEBUG=1` — append one line per Zen request to
  `<tmpdir>/zen-free-tier-headers.log` (path, session prefix, tool counts;
  never keys)
- `OPENCODE_SERVER_URL` — override the background service URL

Known limits:

- One Zen request per `omp` run bypassed `globalThis.fetch` with `omp/18.10.2`
  despite the patch and could not be patched from an extension. On
  `omp/18.12.2` headless runs, every observed Zen call went through the
  patch; if a turn still returns 403, capture it with `ZEN_HEADERS_DEBUG=1`
  and check whether a request is missing from the log.
- Session rotation on 403 is capped (3 per process). A 403 now usually means
  a missing header, a missing `read` tool, or a non-streaming body, so
  rotation stops instead of minting sessions the gateway will reject anyway.
- `opencode` must be version 1.18.0 or newer: the gateway answers older UA
  versions with 426 `UpgradeRequired`. The extension reads the installed
  version at load.

### Request-shape check

Identity headers are not the whole story: the gateway also validates the
body. The current minimum (measured 2026-10-19) is one tool named exactly
`read` plus `"stream": true`. A tool-less body, a non-streaming body, or a
slate without `read` is refused with 403 `FreeTierError`; `bash`, `edit`,
`glob`, `grep`, `write`, and `task` alone are all refused. The `read`
schema is ignored, so `{"type":"object","properties":{}}` passes.
`tool_choice` is not checked. Free models serve chat completions only:
`/zen/v1/responses` returns 400 `ModelProtocolUnsupported`.

Since 1.2.0 the extension appends fail-open stubs for the five core names
(`bash`, `read`, `edit`, `glob`, `grep`) to string JSON bodies that lack
them. This is what lets tool-less auxiliary calls (titles, summaries) pass
today: the injected `read` satisfies the gate. Stubs are never registered in
the harness, so a model call to one errors and the model recovers. The full
core set stays injected so the request also passes if the gate tightens
again. `ZEN_INJECT_TOOLS=0` disables injection.

History: during the strict period a four-tool advisor slate (`advise`,
`read`, `glob`, `grep`) was refused while a thirteen-tool slate passed, which
is why the README used to prescribe a `WATCHDOG.yml` roster. That workaround
is obsolete: the advisor's default slate passes now. Keeping the roster still
works, but it makes the advisor a full agent (it gains `bash`, `edit`,
`write`); omit it if a read-only advisor is preferred.

## Installation

### For Pi (`pi`)
```bash
pi install git:github.com/cutieway/pi-opencode-fix
```

### For Oh My Pi (`omp`)
```bash
omp install git:github.com/cutieway/pi-opencode-fix
```

### Manual Installation
Copy `extensions/opencode-fix.ts` into:
- `~/.pi/agent/extensions/opencode-fix.ts` (for `pi`)
- `~/.omp/agent/extensions/opencode-fix.ts` (for `omp`)

### Windows 11

[`OMP-WINDOWS-SETUP.md`](OMP-WINDOWS-SETUP.md) is a self-contained prompt to hand to OpenCode on a Windows machine. It embeds this extension's source — nothing to download, install, or build — and then walks through the Zen credential, the free model roles, and how to capture request dumps when a request is still refused.

## Usage

OpenCode Zen's free-model catalog changes frequently, so check the current list before choosing a model:

```bash
pi --list-models free
omp models find free
```

For example, `deepseek-v4.1-flash-free`, `mimo-v2.6-flash-free`, and
`space-bunny-free` are currently available. Select a model shown by your own
model list; availability can change (`muse-spark-1.3-contributor-free` was
retired on 2026-10-17 and now answers 410 `ModelDeprecated`):

```bash
pi --model deepseek-v4.1-flash-free -p "hi"
omp --model opencode-zen/deepseek-v4.1-flash-free -p "hi"
```

## Free models through the relay (`zen_ask`)

`extensions/zen-relay.ts` registers a `zen_ask` tool that runs the genuine
`opencode` binary (`opencode run --model opencode/<id>`) and returns its text
answer. It was added while the gateway refused `pi`/`omp` outright; direct
access works again, so treat it as an optional second opinion / isolation
path rather than the only way in. The nested run is a full agent turn with
its own tools in the session directory — text in, text out. It cannot use the
harness's tools or see its conversation, so put everything it needs in
`prompt`. Only free models are accepted (id ends in `-free`, plus
`big-pickle`; e.g. `deepseek-v4.1-flash-free`, `space-bunny-free`) — anything
else is refused before running, so the relay can never spend Zen credits.

Params: `prompt` (required), `model` (default
`deepseek-v4.1-flash-free`), `timeoutMs` (default 180000, max 600000),
`autoApprove` (default false: reads and answers work, permission-gated writes
are denied; set true for coding tasks — same trust as the session's own
edit/bash tools), `session` (a `[session: ses_…]` id from a previous answer,
for multi-turn continuity; the CLI now accepts a shape-valid invented id, but
follow-up answers only carry context for a real one).
Answers name the nested run's tools (`[Nested opencode run used tools: …]`)
and carry the nested session id for follow-ups. Output is capped at ~20k
chars. Child stdin is closed so a prompt the CLI cannot ask (trust,
permissions) fails fast instead of hanging; set `OPENCODE_BIN` to override
the binary path.

Requires `opencode` v2 (1.18.0 or newer for free-tier requests) installed and
signed in (`opencode auth login`; `opencode service start` or one TUI launch
for the background service).

## License

[MIT](LICENSE)
