import { WEB_BOT_AUTH_USER_AGENT } from "@buildinternet/releases-core/web-bot-auth";
import { isPrivateOrLocalHost } from "../avatar-ingest.js";

const TIMEOUT_MS = 5_000;
const MAX_BYTES = 64 * 1024;

export type FetchSkipReason =
  | "blocked"
  | "not_found"
  | "http_error"
  | "network_error"
  | "too_large"
  | "invalid_json";

export type FetchReleasesJsonResult =
  | { ok: true; json: unknown }
  | { ok: false; reason: FetchSkipReason; detail?: string };

export interface FetchReleasesJsonOptions {
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

/** HTTPS-only, SSRF-screened, size- and time-capped JSON fetch. Every failure
 *  is a safe no-op (never throws). */
export async function fetchReleasesJson(
  url: string,
  opts: FetchReleasesJsonOptions = {},
): Promise<FetchReleasesJsonResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "blocked", detail: "unparseable url" };
  }
  if (parsed.protocol !== "https:") return { ok: false, reason: "blocked", detail: "not https" };
  if (isPrivateOrLocalHost(parsed.hostname))
    return { ok: false, reason: "blocked", detail: "private host" };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetchImpl(parsed.toString(), {
        redirect: "manual",
        signal: ctrl.signal,
        // Registered bot identity (Cloudflare Bot Submission Form + /bot docs).
        // Callers that need Web Bot Auth signatures should pass makeBotFetch(env)
        // as fetchImpl — signing is layered on top; it does not set User-Agent.
        headers: { accept: "application/json", "user-agent": WEB_BOT_AUTH_USER_AGENT },
      });
    } catch {
      return { ok: false, reason: "network_error" };
    }

    if (res.status === 404) return { ok: false, reason: "not_found" };
    if (res.status >= 300) return { ok: false, reason: "http_error", detail: String(res.status) };

    const reader = res.body?.getReader();
    if (!reader) {
      let text: string;
      try {
        text = await res.text();
      } catch {
        return { ok: false, reason: "network_error" };
      }
      // Approximate cap on the rare no-stream fallback path; the streaming path
      // below enforces the exact byte cap.
      if (text.length > MAX_BYTES) return { ok: false, reason: "too_large" };
      return parseJson(text);
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch {
        return { ok: false, reason: "network_error" };
      }
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too_large" };
      }
      chunks.push(chunk.value);
    }
    return parseJson(new TextDecoder().decode(concat(chunks, total)));
  } finally {
    clearTimeout(timer);
  }
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function parseJson(text: string): FetchReleasesJsonResult {
  try {
    return { ok: true, json: JSON.parse(text) };
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
}
