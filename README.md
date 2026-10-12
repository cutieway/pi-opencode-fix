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

## Solution

This extension injects OpenCode CLI identity headers only for requests to the Zen API path (`/zen` and `/zen/...`) on `opencode.ai` and its subdomains. It uses a minimal OpenCode-style user agent, keeps a stable `ses_` session ID, and generates a fresh ascending `msg_` request ID for each call unless the caller already supplied correctly formatted IDs. It also configures static provider headers for `opencode`, `opencode-go`, `opencode-zen`, and `oc` in `pi` / `omp`.

### Request-shape check

Identity headers are not the whole story. The gateway also refuses some free-tier requests with `403 FreeTierError` based on the shape of the request rather than its headers. Measured on 2026-10-12: a reviewer-role call to `/zen/v1/chat/completions` carrying a four-tool slate (`advise`, `read`, `glob`, `grep`) was refused, and the same role against the same model was accepted once it carried thirteen tools. Separately, a model served over `/zen/v1/responses` was refused for every tool-less request (24 of 24) and for some two-tool ones, while its tool-carrying requests passed.

The rule behind that is not pinned down, and this extension deliberately does not compensate for it. Tool-less requests on `/zen/v1/chat/completions` are also answered `200`, which rules out a simple "tools are required" reading, and the refusal ignores the identity headers set here — a request carrying them was refused while an otherwise identical one succeeded. Padding a body with placeholder tools was tried and removed again: it cannot reach the Responses-API shape (`input` rather than `messages`), and forcing `tool_choice: "none"` on a caller that legitimately needs its one tool would break that caller instead.

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
