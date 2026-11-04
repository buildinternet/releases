/**
 * SSRF guard for outbound fetches of third-party URLs (feeds, changelog pages,
 * help-center APIs, video feeds). Those URLs come from source rows that can be
 * created through owner manifests and the self-serve listing lane, and from
 * pagination links in the fetched content itself, so the worker must not
 * follow them to loopback, private, link-local or internal hosts.
 *
 * `guardFetch(fetchImpl)` returns a drop-in `fetch` that screens the target
 * and, when the caller asked to follow redirects (the default), follows them
 * itself with `redirect: "manual"` so every hop is screened too. Synchronous
 * host checks only: Workers can't pre-resolve DNS, so a public name that
 * resolves to a private address is out of reach here (same limit as the
 * avatar and media guards).
 */
import { isPrivateOrReservedIp } from "./webhook-url-safety.js";

const DEFAULT_MAX_REDIRECTS = 5;

export class BlockedOutboundUrlError extends Error {
  constructor(
    readonly url: string,
    readonly reason: string,
  ) {
    super(`outbound fetch blocked (${reason}): ${url}`);
    this.name = "BlockedOutboundUrlError";
  }
}

/** True when a hostname must never be fetched: internal names or a private / reserved IP literal. */
export function isBlockedOutboundHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (!h) return true;
  const bare = h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
  if (bare === "localhost" || bare.endsWith(".localhost")) return true;
  if (bare.endsWith(".local") || bare.endsWith(".internal") || bare === "metadata") return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bare)) {
    if (bare.split(".").some((n) => Number(n) > 255)) return true;
    return isPrivateOrReservedIp(bare);
  }
  if (bare.includes(":")) return isPrivateOrReservedIp(bare);
  // Single-label names (`intranet`, `db`) only resolve inside a private network.
  return !bare.includes(".");
}

/** Throws `BlockedOutboundUrlError` unless `url` is an http(s) URL on a public host. */
export function assertFetchableUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BlockedOutboundUrlError(url, "invalid url");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new BlockedOutboundUrlError(url, "scheme");
  }
  if (isBlockedOutboundHost(parsed.hostname)) {
    throw new BlockedOutboundUrlError(url, "private or internal host");
  }
  return parsed;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * Wrap a fetch so every request (and every redirect hop) is SSRF-screened.
 * `redirect: "manual"` and `"error"` keep their usual meaning; `"follow"` (the
 * default) is emulated hop by hop, up to `maxRedirects`.
 */
export function guardFetch(
  fetchImpl: typeof fetch = fetch,
  opts: { maxRedirects?: number } = {},
): typeof fetch {
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const guarded = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const startUrl =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    assertFetchableUrl(startUrl);
    const mode = init?.redirect ?? (input instanceof Request ? input.redirect : "follow");
    if (mode !== "follow") return fetchImpl(input, init);

    let current = startUrl;
    let hopInit: RequestInit = { ...init, redirect: "manual" };
    let res = await fetchImpl(input instanceof Request ? input : current, hopInit);
    for (let hop = 0; isRedirect(res.status); hop++) {
      const location = res.headers.get("location");
      if (!location) return res;
      if (hop >= maxRedirects) throw new BlockedOutboundUrlError(current, "too many redirects");
      current = assertFetchableUrl(new URL(location, current).toString()).toString();
      const method = (hopInit.method ?? "GET").toUpperCase();
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
        const { body: _body, ...rest } = hopInit;
        hopInit = { ...rest, method: method === "HEAD" ? "HEAD" : "GET" };
      }
      // Drain the redirect body so the connection can be reused.
      await res.body?.cancel().catch(() => undefined);
      // oxlint-disable-next-line no-await-in-loop -- redirect hops are inherently sequential
      res = await fetchImpl(current, hopInit);
    }
    return res;
  };
  return guarded as typeof fetch;
}
