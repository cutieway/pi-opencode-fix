import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const OPENCODE_VERSION = "1.18.31";
const USER_AGENT = `opencode/${OPENCODE_VERSION} ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14`;

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
    headers.set("x-opencode-session", getSessionId());
    headers.set("x-opencode-request", generateId("msg", false));
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
