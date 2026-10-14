import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { Type } from "typebox";

/**
 * zen_ask — consult a free OpenCode Zen model through the genuine `opencode`
 * binary and return its text answer.
 *
 * Why this exists: since ~2026-10-13 the Zen gateway refuses free-tier
 * requests from third-party harnesses (403 FreeTierError) no matter which
 * client-identity headers are spoofed (see opencode-fix.ts and README.md).
 * The genuine CLI still passes, so this tool shells out to it: text prompt
 * in, text answer out. The nested `opencode run` is a full agent turn with
 * its own tools in the session directory — it cannot see or call omp/pi
 * tools, and omp/pi cannot steer its tool use beyond the prompt text.
 *
 * Cost guard: only free models are allowed (id ends in `-free`, plus
 * `big-pickle`). Paid model ids are rejected before anything runs.
 */

const DEFAULT_MODEL = "muse-spark-1.3-contributor-free";
const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_CHARS = 20_000;
const MAX_STDERR_CHARS = 2_000;

function isFreeModel(model: string): boolean {
  const id = model.includes("/") ? model.split("/").pop()! : model;
  return id === "big-pickle" || id.endsWith("-free");
}

function toProviderModel(model: string): string {
  return model.includes("/") ? model : `opencode/${model}`;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n…[truncated, ${text.length - max} chars omitted]`;
}

interface RelayResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runOpencode(args: string[], cwd: string, timeoutMs: number, signal: AbortSignal | undefined): Promise<RelayResult> {
  return new Promise((resolve) => {
    const bin = process.env.OPENCODE_BIN?.trim() || "opencode";
    let child;
    try {
      // stdin ignored: a prompt the child cannot ask (trust, permissions)
      // must fail fast, never hang the tool until timeout.
      child = spawn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } });
    } catch (err) {
      resolve({ code: null, stdout: "", stderr: String(err), timedOut: false });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number | null, timedOut: boolean) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };
    child.stdout?.on("data", (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT_CHARS + 1024) stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < MAX_STDERR_CHARS + 1024) stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      finish(null, false);
      stderr += `\nspawn error: ${(err as Error).message}`;
    });
    child.on("close", (code) => finish(code, false));
    const onTimeout = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already exited.
      }
      finish(null, true);
    };
    timer = setTimeout(onTimeout, timeoutMs);
    const onAbort = () => {
      clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch {
        // Already exited.
      }
      finish(null, false);
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

const paramsSchema = Type.Unsafe({
  type: "object",
  properties: {
    prompt: {
      type: "string",
      description: "The question or task for the free Zen model. Include any code or context it needs; it cannot access omp/pi tools or conversation history.",
    },
    model: {
      type: "string",
      description: `Free Zen model id (default: ${DEFAULT_MODEL}). Only *-free models and big-pickle are accepted.`,
    },
    timeoutMs: {
      type: "number",
      description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).`,
    },
  },
  required: ["prompt"],
  additionalProperties: false,
});

interface ZenAskParams {
  prompt: string;
  model?: string;
  timeoutMs?: number;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool?.({
    name: "zen_ask",
    label: "Ask free Zen model",
    description:
      "Ask a free OpenCode Zen model a question via the genuine opencode CLI and return its text answer. " +
      "Use for second opinions, summaries, or reviews from models like muse-spark-1.3-contributor-free. " +
      "Text in / text out: the nested run cannot use this session's tools and has no conversation context, " +
      "so include everything it needs in prompt. It runs as its own agent turn in the session directory " +
      "with opencode's own permission system. Only free models are accepted.",
    parameters: paramsSchema,
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      const { prompt, model = DEFAULT_MODEL, timeoutMs = DEFAULT_TIMEOUT_MS } = params as ZenAskParams;
      if (typeof prompt !== "string" || prompt.trim() === "") {
        return {
          content: [{ type: "text", text: "zen_ask: prompt must be a non-empty string." }],
          details: undefined,
          isError: true,
        };
      }
      if (!isFreeModel(model)) {
        return {
          content: [
            {
              type: "text",
              text: `zen_ask: refusing non-free model "${model}" — this relay only serves *-free models and big-pickle to avoid spending Zen credits.`,
            },
          ],
          details: undefined,
          isError: true,
        };
      }
      const timeout = Math.min(Math.max(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 10_000), MAX_TIMEOUT_MS);
      const cwd = ctx?.cwd || process.cwd();
      const result = await runOpencode(["run", "--model", toProviderModel(model), prompt], cwd, timeout, signal);

      if (result.timedOut) {
        return {
          content: [{ type: "text", text: `zen_ask: opencode run timed out after ${timeout}ms.` }],
          details: undefined,
          isError: true,
        };
      }
      if (result.code !== 0) {
        const errTail = truncate(result.stderr.trim(), MAX_STDERR_CHARS);
        return {
          content: [
            {
              type: "text",
              text: `zen_ask: opencode run failed (exit ${result.code}). ${errTail}\nHint: run \`opencode auth login\` so the CLI itself can reach Zen, then retry.`,
            },
          ],
          details: undefined,
          isError: true,
        };
      }
      const answer = result.stdout.trim();
      if (!answer) {
        return {
          content: [{ type: "text", text: "zen_ask: opencode run produced no output." }],
          details: undefined,
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: truncate(answer, MAX_OUTPUT_CHARS) }],
        details: undefined,
        isError: false,
      };
    },
  });
}
