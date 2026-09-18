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

This extension automatically injects the official OpenCode CLI headers (`User-Agent: opencode/1.18.31...`, `x-opencode-client: cli`, `x-opencode-project: global`, and synchronized `x-opencode-session` / `x-opencode-request` identifiers) into all outbound request headers targeting `opencode.ai`, and configures provider headers for `opencode`, `opencode-go`, `opencode-zen`, and `oc` in `pi` / `omp`.

## Installation

### For Pi (`pi`)
```bash
pi install git:github.com/lutfi-zain/pi-opencode-fix
```

### For Oh My Pi (`omp`)
```bash
omp install git:github.com/lutfi-zain/pi-opencode-fix
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
