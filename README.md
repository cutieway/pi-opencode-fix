# pi-opencode-fix

Extension package for **Pi Coding Agent (`pi`)** and **Oh My Pi (`omp`)** that fixes HTTP 403 `FreeTierError` and HTTP 429 `FreeUsageLimitError` when calling OpenCode Zen models (such as `muse-spark-1.3-contributor-free` and `deepseek-v4-flash-free`).

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

Once installed, run `pi` or `omp` with any OpenCode model:

```bash
pi --model deepseek-v4-flash-free -p "hi"
omp --model deepseek-v4-flash-free -p "hi"
```

## License

[MIT](LICENSE)
