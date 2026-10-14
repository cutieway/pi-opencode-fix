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
This occurs because the OpenCode Zen API gateway (`https://opencode.ai/zen/v1`) enforces client identity checks (`User-Agent`, `x-opencode-client`, `x-opencode-project`, and valid synchronized session/request timestamp IDs).

## Status (2026-10-14): the header patch is no longer sufficient

As of ~2026-10-13 the Zen gateway rejects free-tier requests from `pi`/`omp`
even with full client-identity parity. Verified live against
`https://opencode.ai/zen/v1` (same key, same machine): every variant below
returns `403 FreeTierError`, while the genuine `opencode` CLI answers `200`
with the same model:

- v1 headers (`opencode/1.18.31`, `cli`, `global`, shape-valid `ses_`/`msg_`)
- v2 headers (`opencode/latest/2.0.27/cli`, all five session-header variants)
- fabricated `ses_` IDs **and** server-registered session IDs minted via the
  local opencode background service (`POST /api/session`)
- tool-less bodies **and** bodies carrying 11–12 real tools **and** bodies
  with injected `bash`/`read`/`edit`/`glob`/`grep` stubs
- `/zen/v1/responses` **and** `/zen/v1/chat/completions`

Version 1.2.0 of this extension implements the full parity set anyway
(closest-possible behavior, fail-open, debug logging) in case the gate
relaxes, but **today free Zen models work through `opencode` directly (or a
front-end driving it, e.g. OpenChamber), not through `pi`/`omp`**. In `omp`,
keep a non-Zen fallback in `retry.fallbackChains` (e.g. a DeepSeek model) so
refused turns degrade instead of failing.

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

- One Zen request per `omp` run bypasses `globalThis.fetch` (observed with
  `omp/18.10.2` UA despite the patch) and cannot be patched from an
  extension; it fails the same way as everything else.
- Session rotation on 403 is capped (3 per process): a 403 is usually a gate
  verdict, not a stale session, so rotation stops instead of minting
  sessions the gateway will reject anyway.

### Request-shape check

Identity headers are not the whole story. The gateway also refuses some free-tier requests with `403 FreeTierError` based on the shape of the request rather than its headers. Measured on 2026-10-12: a reviewer-role call to `/zen/v1/chat/completions` carrying a four-tool slate (`advise`, `read`, `glob`, `grep`) was refused, and the same role against the same model was accepted once it carried thirteen tools. Separately, a model served over `/zen/v1/responses` was refused for every tool-less request (24 of 24) and for some two-tool ones, while its tool-carrying requests passed.

The rule behind that is not pinned down. Since 1.2.0 the extension appends
fail-open stubs for the missing core names (`bash`, `read`, `edit`, `glob`,
`grep`) to string JSON bodies, but live tests on 2026-10-14 show stubs do not
restore acceptance either: tool-less, stubbed, and full-slate bodies are all
refused alike. Padding a body with placeholder tools was tried and removed again: it cannot reach the Responses-API shape (`input` rather than `messages`), and forcing `tool_choice: "none"` on a caller that legitimately needs its one tool would break that caller instead.

What did resolve it was giving the refused role a larger `tools` slate in its own configuration. For `omp`, that is a `WATCHDOG.yml` roster entry, because the global `advisor:` block cannot express `tools`:

```yaml
advisors:
  - name: Advisor
    tools: [read, bash, edit, ask, eval, glob, grep, task, wait, todo, web_search, write]
```

The advisor's default slate is the read-only set (`read`, `grep`, `glob`, plus its own `advise`), and that four-name shape was the one being refused.

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

[`OMP-WINDOWS-SETUP.md`](OMP-WINDOWS-SETUP.md) is a self-contained prompt to hand to OpenCode on a Windows machine. It embeds this extension's source — nothing to download, install, or build — and then walks through the Zen credential, the free model roles, the advisor's tool slate, and how to capture request dumps when a request is still refused.

## Usage

OpenCode Zen's free-model catalog changes frequently, so check the current list before choosing a model:

```bash
pi --list-models free
omp models find free
```

For example, `muse-spark-1.3-contributor-free` is currently available. Select a model shown by your own model list; availability can change:

```bash
pi --model muse-spark-1.3-contributor-free -p "hi"
omp --model muse-spark-1.3-contributor-free -p "hi"
```

## License

[MIT](LICENSE)
