import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Inject opencode User-Agent header for all outbound calls to opencode.ai
const originalFetch = globalThis.fetch;
globalThis.fetch = async function (input: RequestInfo | URL, init?: RequestInit) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (typeof url === "string" && url.includes("opencode.ai")) {
    if (init) {
      init.headers = init.headers || {};
      if (init.headers instanceof Headers) {
        init.headers.set("User-Agent", "opencode/latest/1.14.50/cli");
      } else if (Array.isArray(init.headers)) {
        init.headers.push(["User-Agent", "opencode/latest/1.14.50/cli"]);
      } else {
        (init.headers as Record<string, string>)["User-Agent"] = "opencode/latest/1.14.50/cli";
      }
    }
  }
  return originalFetch(input, init);
};

export default function (pi: ExtensionAPI) {
  const providers = ["oc", "opencode", "opencode-go"];
  for (const p of providers) {
    pi.registerProvider(p, {
      headers: {
        "User-Agent": "opencode/latest/1.14.50/cli"
      }
    });
  }
}
