# pi-opencode-fix

Extension package for **Pi Coding Agent (`pi`)** and **Oh My Pi (`omp`)** that gives requests to OpenCode Zen the identity and prompt shape of the genuine OpenCode CLI, so free models answer directly in the harness, plus bounded 429 retries that stop the turn after three attempts instead of retrying forever.

## Problem

When using OpenCode models with `pi` or `omp`, requests may fail with:
```text
403: {"type":"FreeTierError","message":"Error from provider (Console): OpenCode's free tier can only be used from within OpenCode"}
```
or:
```text
429: {"type":"FreeUsageLimitError","message":"Error from provider (Console): Rate limit exceeded. Please try again later."}
```
This happens because the OpenCode Zen API gateway (`https://opencode.ai/zen/v1`)
serves free-tier requests only to clients that look like the OpenCode CLI. Two
checks are stacked in front of the model:

- a request-shape check that answers `403 FreeTierError` when the OpenCode
  `User-Agent`, a shape-valid `x-opencode-session` id, a tool, or a streaming
  body is missing;
- a prompt-shape check (since 2026-10-24) that wants an `<env>` … `</env>`
  block in the system message and answers `429 FreeUsageLimitError` without it
  — or `403 FreeTierError` when the rest of the prompt is also far from
  OpenCode's own.

`pi`/`omp` satisfy neither on their own, so the gateway refuses them before any
model runs. See
[Status](#status-2026-10-24-working-the-429-is-an-env-block-check).

## Status (2026-10-24): working — the 429 is an `<env>` block check

On 2026-10-24 every forged request to the free lane started coming back
`429 FreeUsageLimitError`, while the genuine `opencode run` on the same key,
same IP, same minute answered `200`. That looked like per-day metering. It was
not: the `429` is a second shape check, and the thing it looks for is an
`<env>` … `</env>` block in the **system message**. Replaying the captured
genuine request with Bun's `fetch` reproduces `200`; changing that one part of
the body flips it to `429` and back:

| Variant of the captured genuine request | Result |
|---|---|
| unchanged (replayed over HTTP/1.1 and HTTP/2) | 200 |
| system prompt replaced with a generic one | 429 |
| system prompt removed | 429 |
| system prompt truncated to its first 6000 / 2000 / 600 / 170 characters | 429 |
| only the last 600 characters of the system prompt | 200 |
| system message set to `<env></env>` | 200 |
| system message set to `<env>` (no close tag) | 429 |
| system message set to `<ENV></ENV>` | 429 |
| system message set to `<env>garbage</env>` | 200 |
| the same `<env></env>` block moved to a user message | 429 |
| env block present, all tools removed | 403 `FreeTierError` (the older shape check) |

So the check is a heuristic, not a signature: tag names are matched
case-sensitively and the content between them is ignored. A missing block is
usually a `429`, but a harness prompt that differs more from OpenCode's own
can get the older `403 FreeTierError` instead — both disappear once the block
is present. Fresh session and project IDs pass, and the stored key is not the
discriminator (the harness key and the opencode key are byte-identical).
OpenCode's own prompt always carries an env block, so the gateway presumably
uses it as its "is this our agent loop?" marker.

Since 1.4.0 the extension appends that block to the system message of every
`opencode.ai` JSON request that lacks one, and creates a system message if the
harness sent none. It appends rather than prepends, so the harness prompt keeps
its position. Verified live: `omp` 18.12.6 then answered through
`opencode-zen/deepseek-v4.1-flash-free` in ~7 s, executed a shell tool call in
the same turn, and produced reasoning with `--thinking high`; the same works on
`glm-5.3-flash-free`.

A `429` is still possible — a real bucket limit, or the shape check when env
injection is disabled — and the extension bounds it instead of caching it:

- the same request is re-sent at most three times per turn, after 2 s and 5 s;
- if the third answer is still `429` the turn stops with a non-retryable `422`
  that names the model, the attempt count, and the reset time from
  `retry-after-ms` / `retry-after` when the server sent one. The wording avoids
  `429` and "rate limit" because omp treats those as retryable, and 422 is
  outside both its fetch and turn-recovery retry sets, so nothing re-sends the
  turn and no request body is dumped to disk;
- nothing is remembered across turns: the limit is shared by IP and account,
  not by model, and OpenCode itself can start answering again at any time, so a
  stored deadline would only outlive the real state. The next prompt sends a
  fresh request.

## History: the earlier shape check

Before the env check there was a stricter request-shape gate, live from
~2026-10-13 through at least 2026-10-15. It relaxed on its own: the fix refused
on 2026-10-15 answered `200` from 2026-10-19. Verified live on 2026-10-19
against `https://opencode.ai/zen/v1/chat/completions` with
`deepseek-v4.1-flash-free`, `mimo-v2.6-flash-free`, and `space-bunny-free`
(retired since):

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

During that window the rule was: an OpenCode `User-Agent` at version 1.18.0 or
newer, one shape-valid session ID, at least one tool named exactly `read`,
and a streaming request. A server-registered session was not required;
generated shape-valid IDs passed, and the genuine CLI accepted them too.

`omp` 18.12.2 with this extension answered through Zen directly, including the
advisor's default `advise`/`read`/`glob`/`grep` slate. The
`WATCHDOG.yml` tool-roster workaround from the strict period is no longer
needed; keeping it still works but turns the advisor into a full agent.

The identity headers are still required whenever the lane is open. Verified on
2026-10-19 with `omp --no-extensions`: both free models returned 403
`FreeTierError`, and the printed answer came from the
`retry.fallbackChains` fallback to `deepseek/deepseek-v4-flash-vision-exp`
(remove that chain: it bills a paid model behind the user's back).

## Solution

This extension patches requests to `opencode.ai` and its subdomains so they look
like the genuine client:

- OpenCode CLI identity headers: the v2 user agent
  (`opencode/latest/<local-version>/cli`, read from the installed `opencode`
  binary), a server-registered session ID from the local opencode background
  service when available (falling back to a shape-valid generated ID), all five
  session-header variants, and a fresh `msg_` request ID per call.
- An `<env>` … `</env>` block in the system message, appended if missing (see
  [Status](#status-2026-10-24-working-the-429-is-an-env-block-check)).
- Fail-open stubs for core OpenCode tool names on string JSON bodies that lack
  them (skipped for forced `tool_choice`); see `ZEN_INJECT_TOOLS=0` below.

It also configures static provider headers for `opencode`, `opencode-go`,
`opencode-zen`, and `oc` in `pi` / `omp`, and turns a `429` that survives three
attempts into a stopped turn with the reset time instead of an endless retry.

Prerequisites for the registered-session path: `opencode` installed (1.18.0
or newer; 2.1.4 verified) and its background service running
(`opencode service start`, or open the TUI once). Without the service the
extension fails open to generated IDs.

Env:

- `ZEN_INJECT_ENV=0` — disable env-block injection (headers and tools still
  patched; requests are answered with `429 FreeUsageLimitError`)
- `ZEN_INJECT_TOOLS=0` — disable tool-stub injection (headers still patched)
- `ZEN_HEADERS_DEBUG=1` — append one line per Zen request to
  `<tmpdir>/zen-free-tier-headers.log` (path, session prefix, tool and env
  flags, retry count and reset time; never keys)
- `OPENCODE_SERVER_URL` — override the background service URL

Known limits:

- The env check is server-side and undocumented; a future change can add a
  condition this extension does not satisfy. The flags above and
  `ZEN_HEADERS_DEBUG=1` are there to tell a shape rejection (`429` with no
  request in the log, or `403`) apart from a real limit (three logged requests,
  `retry-after` present).
- One Zen request per `omp` run bypassed `globalThis.fetch` with `omp/18.10.2`
  despite the patch and could not be patched from an extension. On
  `omp/18.12.6` headless runs, every observed Zen call went through the
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
body. Two checks run in order:

1. **Shape** (answers `403 FreeTierError`): an OpenCode `User-Agent` at
   version 1.18.0 or newer, a shape-valid session ID, at least one tool named
   exactly `read`, and `"stream": true`. A tool-less or non-streaming body is
   refused; `bash`, `edit`, `glob`, `grep`, `write`, and `task` alone are all
   refused. The `read` schema is ignored, so `{"type":"object","properties":{}}`
   passes. `tool_choice` is not checked.
2. **Prompt shape** (answers `429 FreeUsageLimitError`): the system message
   must contain `<env>` … `</env>`. Case-sensitive, content ignored, and it
   has to be the system message — the same block in a user message does not
   count.

Free models serve chat completions only: `/zen/v1/responses` returns 400
`ModelProtocolUnsupported`.

Since 1.2.0 the extension appends fail-open stubs for the five core names
(`bash`, `read`, `edit`, `glob`, `grep`) to string JSON bodies that lack
them. This is what lets tool-less auxiliary calls (titles, summaries) pass
today: the injected `read` satisfies the 403 check. Stubs are never registered
in the harness, so a model call to one errors and the model recovers. The full
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

For example, `deepseek-v4.1-flash-free`, `glm-5.3-flash-free`,
`mimo-v2.6-flash-free`, `beam-free`, `jev-1.13-free`, and `big-pickle` were in
the catalog on 2026-10-24. Select a model shown by your own model list;
availability changes (`space-bunny-free` and
`muse-spark-1.3-contributor-free` were retired, the latter now answers 410
`ModelDeprecated`):

```bash
pi --model opencode/deepseek-v4.1-flash-free -p "hi"
omp --model opencode-zen/deepseek-v4.1-flash-free -p "hi"
```

Both harnesses need their own Zen credential (`omp login opencode-zen`; for
`pi`, the `opencode` provider reads `OPENCODE_API_KEY` or its `/login`).
Provider-prefix the model id: `pi` resolves it as `opencode/<id>`, `omp` as
`opencode-zen/<id>` (an unambiguous bare id also works on `omp`). The `omp`
example is verified live; `pi` is not verified here (no Zen credential for
`pi` on the author's machine), and its catalog may lag — `pi update --models`
refreshes it, and an id missing from the catalog is sent as a custom model
id.

## License

[MIT](LICENSE)
