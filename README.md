# pi-opencode-fix

Extension package for **Pi Coding Agent (`pi`)** and **Oh My Pi (`omp`)** that fixes HTTP 429 `FreeUsageLimitError` when calling OpenCode Zen / DeepSeek models (such as `deepseek-v4-flash-free`).

## Problem

When using OpenCode models (e.g. `deepseek-v4-flash-free`) with `pi` or `omp`, requests fail with:
```text
429: {"type":"FreeUsageLimitError","message":"Error from provider (Console): Rate limit exceeded. Please try again later."}
```
This occurs because the OpenCode Zen API gateway (`https://opencode.ai/zen/v1/chat/completions`) enforces a `User-Agent` check. If the `User-Agent` does not identify as `opencode`, the gateway returns a synthetic HTTP 429 error.

## Solution

This extension automatically injects `User-Agent: opencode/latest/1.14.50/cli` into all outbound request headers targeting `opencode.ai` and configures provider headers for `opencode`, `opencode-go`, and `oc` in `pi` / `omp`.

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
