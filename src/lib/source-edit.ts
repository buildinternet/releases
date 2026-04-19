export const VALID_FEED_TYPES = ["rss", "atom", "jsonfeed"] as const;
export type FeedType = (typeof VALID_FEED_TYPES)[number];

export function inferFeedTypeFromUrl(url: string): FeedType {
  const lower = url.toLowerCase();
  if (lower.endsWith(".json") || lower.includes("feed.json")) return "jsonfeed";
  if (lower.includes("atom")) return "atom";
  return "rss"; // safe default — RSS parser handles most XML feeds
}

export type ResolveFeedUpdateInput = {
  feedUrl?: string | boolean;
  feedType?: string;
};

export type ResolveFeedUpdateResult =
  | { ok: true; action: "none" }
  | { ok: true; action: "remove" }
  | { ok: true; action: "set"; feedUrl: string; feedType: FeedType }
  | { ok: false; error: string };

/**
 * Decide how to update a source's feed metadata from the flags on
 * `releases admin source edit`. Pure helper — no DB or I/O — so it can be
 * unit-tested directly.
 *
 * Rules:
 * - `--feed-type` without `--feed-url` is meaningless (nothing to update).
 * - `--feed-type` must be one of `VALID_FEED_TYPES`.
 * - When both are passed, the explicit type wins over URL inference.
 * - `--no-feed-url` (feedUrl === false) removes the stored feed.
 */
export function resolveFeedUpdate(input: ResolveFeedUpdateInput): ResolveFeedUpdateResult {
  const { feedUrl, feedType } = input;

  if (feedType !== undefined) {
    if (!(VALID_FEED_TYPES as readonly string[]).includes(feedType)) {
      return {
        ok: false,
        error: `Invalid feed type "${feedType}". Must be one of: ${VALID_FEED_TYPES.join(", ")}`,
      };
    }
    if (typeof feedUrl !== "string") {
      return {
        ok: false,
        error: "--feed-type requires --feed-url. Pass both together to set or update the feed.",
      };
    }
    return { ok: true, action: "set", feedUrl, feedType: feedType as FeedType };
  }

  if (feedUrl === false) {
    return { ok: true, action: "remove" };
  }

  if (typeof feedUrl === "string") {
    return { ok: true, action: "set", feedUrl, feedType: inferFeedTypeFromUrl(feedUrl) };
  }

  return { ok: true, action: "none" };
}

export type ResolveFetchUrlInput = { fetchUrl?: string | boolean };
export type ResolveFetchUrlResult =
  | { action: "none" }
  | { action: "remove" }
  | { action: "set"; fetchUrl: string };

/**
 * Decide how to update a source's direct-fetch URL from `--fetch-url` /
 * `--no-fetch-url`. Pure helper — no DB or I/O.
 *
 * Both set and remove also clear the conditional-fetch headers
 * (`fetchEtag`, `fetchLastModified`) — the caller is expected to apply that
 * cleanup. Stale headers tied to a different URL would otherwise produce
 * misleading 304s on the next fetch.
 */
export function resolveFetchUrlUpdate(input: ResolveFetchUrlInput): ResolveFetchUrlResult {
  if (input.fetchUrl === false) return { action: "remove" };
  if (typeof input.fetchUrl === "string") return { action: "set", fetchUrl: input.fetchUrl };
  return { action: "none" };
}
