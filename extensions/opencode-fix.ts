import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const OPENCODE_VERSION = "1.18.31";
const USER_AGENT = `opencode/${OPENCODE_VERSION} ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14`;

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

// Monkey-patch globalThis.fetch to inject OpenCode CLI headers into all requests to opencode.ai
const originalFetch = globalThis.fetch;
globalThis.fetch = async function (input: RequestInfo | URL, init?: RequestInit) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

  if (typeof url === "string" && url.includes("opencode.ai")) {
    init = init || {};
    const now = Date.now();
    const sessionId = generateId("ses", true, now - 3000);
    const requestId = generateId("msg", false, now);

    const headersToInject: Record<string, string> = {
      "User-Agent": USER_AGENT,
      "user-agent": USER_AGENT,
      "x-opencode-client": "cli",
      "x-opencode-project": "global",
      "x-opencode-session": sessionId,
      "x-opencode-request": requestId,
    };

    if (!init.headers) {
      init.headers = headersToInject;
    } else if (init.headers instanceof Headers) {
      for (const [k, v] of Object.entries(headersToInject)) {
        if (!init.headers.has(k) || k.toLowerCase() === "user-agent") {
          init.headers.set(k, v);
        }
      }
    } else if (Array.isArray(init.headers)) {
      for (const [k, v] of Object.entries(headersToInject)) {
        init.headers.push([k, v]);
      }
    } else {
      Object.assign(init.headers, headersToInject);
    }
  }

  return originalFetch(input, init);
};

export default function (pi: ExtensionAPI) {
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
