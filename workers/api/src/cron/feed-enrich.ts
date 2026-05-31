/**
 * Feed content enrichment — follow a summary-only feed item's link, fetch the
 * real article, and return clean body + media. Cheap path first (plain fetch +
 * htmlToMarkdown + single-article AI cleanup); escalate to Cloudflare Browser
 * Rendering only when the cheap path is still thin. Fail-open everywhere: any
 * error or no-improvement returns without content so the caller keeps the feed
 * summary and never loses the item.
 */
import { and, eq, inArray } from "drizzle-orm";
import { htmlToMarkdown, extractMediaFromMarkdown } from "@releases/adapters/feed.js";
import { RELEASES_BOT_UA } from "@releases/adapters/user-agent";
import { fetchCloudflareMarkdown } from "@releases/adapters/cloudflare";
import { extractArticle, MODEL as ARTICLE_MODEL } from "@releases/ai-internal/article-extract";
import { logEvent } from "@releases/lib/log-event";
import { getSecret } from "@releases/lib/secrets";
import { buildAnthropicClient } from "@releases/lib/anthropic-client.js";
import { getAnthropicKey, resolveGatewayOpts, type AnthropicEnv } from "../lib/anthropic.js";
import { makeBotFetch } from "../lib/web-bot-auth-fetch.js";
import { FLAGS, flag, type FlagshipBinding } from "@releases/lib/flags";
import { IN_ARRAY_CHUNK_SIZE } from "../lib/d1-limits.js";
import { releases, sources } from "@buildinternet/releases-core/schema";
import { getSourceMeta } from "@releases/adapters/source-meta.js";
import type { drizzle } from "drizzle-orm/d1";
import type { Source } from "@buildinternet/releases-core/schema";
import type { SourceMetadata } from "@releases/adapters/feed.js";
import type { RawRelease } from "@releases/adapters/types.js";
import {
  isThinItem,
  isEnrichableUrl,
  DEFAULT_FEED_THIN_CHARS,
} from "@releases/adapters/feed-depth";

type ReleaseMedia = { type: "image" | "video" | "gif"; url: string; alt?: string };

/** Hard cap on the cheap-path link fetch so a slow / hanging origin can't stall
 *  the cron fire; on timeout the fetch aborts and we fall through to render
 *  escalation / fail-open. */
const FETCH_TIMEOUT_MS = 10_000;

export interface EnrichDeps {
  /** Improvement bar floor — an enriched body must clear `max(thinChars, 1.5*summaryLen)`. */
  thinChars: number;
  /** Plain HTTP fetch (injectable for tests). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Turn page markdown into clean article content + media. */
  extractArticleFn: (args: {
    markdown: string;
    title: string;
  }) => Promise<{ content: string; media: ReleaseMedia[] }>;
  /** Rendered-markdown fetch for escalation; `null` when CF creds are not bound. */
  renderFn: ((url: string) => Promise<string | null>) | null;
  logEvent: typeof logEvent;
}

export interface EnrichResult {
  status: "enriched" | "no_improvement";
  via?: "fetch" | "render";
  content?: string;
  media?: ReleaseMedia[];
}

export interface EnrichItem {
  url: string;
  title: string;
  summary: string;
}

function bar(summary: string, thinChars: number): number {
  return Math.max(thinChars, Math.ceil(summary.length * 1.5));
}

export async function enrichFeedItem(item: EnrichItem, deps: EnrichDeps): Promise<EnrichResult> {
  // Chokepoint for both the forward path and the backfill route — skip before
  // spending a fetch + extract on URLs that won't yield a single article (see
  // isEnrichableUrl for the shapes).
  if (!isEnrichableUrl(item.url)) {
    deps.logEvent("info", { component: "feed-enrich", event: "skip-url-shape", url: item.url });
    return { status: "no_improvement" };
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const floor = bar(item.summary, deps.thinChars);

  // Cheap path: plain fetch → markdown → AI cleanup. The fetch (and body read)
  // is bounded by an AbortController timer so a hanging origin can't stall us.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(item.url, {
      headers: { "User-Agent": RELEASES_BOT_UA },
      signal: controller.signal,
    });
    if (res.ok) {
      const html = await res.text();
      clearTimeout(timer);
      const markdown = htmlToMarkdown(html);
      const { content, media } = await deps.extractArticleFn({ markdown, title: item.title });
      if (content.length >= floor) {
        return { status: "enriched", via: "fetch", content, media };
      }
    }
  } catch (err) {
    // Includes AbortError on timeout — logged like any cheap-path failure, then
    // we fall through to render escalation.
    deps.logEvent("warn", {
      component: "feed-enrich",
      event: "cheap-fetch-failed",
      url: item.url,
      err,
    });
  } finally {
    clearTimeout(timer);
  }

  // Escalate to Browser Rendering, only when creds are bound.
  if (deps.renderFn) {
    try {
      const markdown = await deps.renderFn(item.url);
      if (markdown) {
        const { content, media } = await deps.extractArticleFn({ markdown, title: item.title });
        if (content.length >= floor) {
          return { status: "enriched", via: "render", content, media };
        }
      }
    } catch (err) {
      deps.logEvent("warn", {
        component: "feed-enrich",
        event: "render-fetch-failed",
        url: item.url,
        err,
      });
    }
  }

  return { status: "no_improvement" };
}

/** Wrap an `extractArticle` call into the `extractArticleFn` shape, pulling media
 *  from the AI-cleaned article body — not the raw page — so nav / sidebar /
 *  "more posts" thumbnails don't attach to the release. `extractArticle`
 *  preserves in-body image markdown, so the body is the right scope. */
export function makeExtractArticleFn(
  runExtract: (markdown: string, title: string) => Promise<{ content: string }>,
): EnrichDeps["extractArticleFn"] {
  return async ({ markdown, title }) => {
    const { content } = await runExtract(markdown, title);
    return { content, media: extractMediaFromMarkdown(content) };
  };
}

/** Env shape `buildEnrichDeps` needs: Anthropic key + gateway routing, plus the
 *  optional Cloudflare Browser-Rendering secret bindings. */
export interface EnrichDepsEnv extends AnthropicEnv {
  CLOUDFLARE_ACCOUNT_ID?: { get(): Promise<string | null> } | { get(): Promise<string> };
  CLOUDFLARE_API_TOKEN?: { get(): Promise<string | null> } | { get(): Promise<string> };
  WEB_BOT_AUTH_ENABLED?: string;
  WEB_BOT_AUTH_PRIVATE_KEY?: { get(): Promise<string> };
}

/**
 * Assemble the runtime `EnrichDeps` from worker env: build the Anthropic client,
 * resolve the (cached) Cloudflare creds for render escalation, and wire the
 * article extractor. Returns `null` when no Anthropic key is configured so each
 * caller decides how to react (cron → skip silently; admin route → 503). Shared
 * by the forward path (`buildEnrichMap`) and the backfill route so the plumbing
 * lives in one place.
 */
export async function buildEnrichDeps(
  env: EnrichDepsEnv,
  thinChars: number,
): Promise<EnrichDeps | null> {
  const apiKey = await getAnthropicKey(env);
  if (!apiKey) return null;
  const client = buildAnthropicClient({ apiKey, ...(await resolveGatewayOpts(env)) });

  // getSecret caches per-isolate and throws on transient failure; soft-fail to
  // null so absent / unreachable creds simply disable render escalation.
  const accountId = await getSecret(env.CLOUDFLARE_ACCOUNT_ID).catch(() => null);
  const apiToken = await getSecret(env.CLOUDFLARE_API_TOKEN).catch(() => null);
  const renderFn =
    accountId && apiToken
      ? (url: string) => fetchCloudflareMarkdown(url, accountId, apiToken)
      : null;

  const extractArticleFn = makeExtractArticleFn(async (markdown, title) => {
    const { content } = await extractArticle(client, { markdown, title, model: ARTICLE_MODEL });
    return { content };
  });

  const fetchImpl = await makeBotFetch(env);
  return { thinChars, extractArticleFn, renderFn, logEvent, fetchImpl };
}

export const DEFAULT_ENRICH_MAX_PER_FIRE = 10;

/** Parse a positive-integer config value; falls back when missing, non-numeric,
 *  or ≤ 0 — so a negative/zero override can't produce a negative `slice(0, cap)`
 *  or an inverted thinness threshold. */
export function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export interface EnrichmentMarker {
  attemptedAt: string;
  succeeded: boolean;
  via?: "fetch" | "render";
}

export interface EnrichOutcome {
  content?: string;
  media?: ReleaseMedia[];
  marker: EnrichmentMarker;
}

/**
 * Number of consecutive all-fail enrichment fires after which the source's
 * circuit breaker trips and enrichment is skipped on subsequent cron fires.
 * Stored in `source.metadata.enrichment.consecutiveFailures`; reset to 0 on
 * any success. Three failures covers transient issues (network blip, model
 * hiccup) while bounding spend on structurally-broken sources.
 */
export const ENRICH_CONSECUTIVE_FAILURE_LIMIT = 3;

/**
 * Returns true when the source's enrichment circuit breaker has tripped —
 * i.e. the consecutive-failure counter has reached or exceeded the limit.
 * Callers should skip enrichment entirely when this returns true.
 */
export function isEnrichmentCircuitOpen(meta: SourceMetadata): boolean {
  const failures = meta.enrichment?.consecutiveFailures ?? 0;
  return failures >= ENRICH_CONSECUTIVE_FAILURE_LIMIT;
}

/**
 * Derives the next `enrichment` metadata block after an attempt.
 * - On failure: increments `consecutiveFailures` (starts from 0 if absent).
 * - On success: resets `consecutiveFailures` to 0.
 */
export function nextEnrichmentMetadata(
  current: SourceMetadata["enrichment"],
  succeeded: boolean,
): NonNullable<SourceMetadata["enrichment"]> {
  if (succeeded) {
    return { consecutiveFailures: 0 };
  }
  return { consecutiveFailures: (current?.consecutiveFailures ?? 0) + 1 };
}

interface EnrichNewThinEnv {
  FEED_ENRICH_ENABLED?: string;
  FEED_ENRICH_MAX_PER_FIRE?: string;
  FEED_THIN_CHARS?: string;
  FLAGS?: FlagshipBinding;
}

/**
 * Forward-path enrichment: pick new, thin items (URL not already in D1), enrich
 * up to the per-fire cap, and return an index→outcome map the caller applies
 * during row mapping. Reads existing URLs via the passed drizzle handle. Never
 * throws — per-item failures are fail-open inside `enrichFeedItem`.
 */
export async function enrichNewThinItems(
  db: ReturnType<typeof drizzle>,
  source: Source,
  meta: SourceMetadata,
  rawReleases: readonly RawRelease[],
  env: EnrichNewThinEnv,
  deps: { enrichFn: (item: EnrichItem) => Promise<EnrichResult> },
): Promise<Map<number, EnrichOutcome>> {
  const out = new Map<number, EnrichOutcome>();
  if (!(await flag(env.FLAGS, env.FEED_ENRICH_ENABLED, FLAGS.feedEnrichEnabled))) return out;
  if (meta.feedContentDepth !== "summary-only") return out;
  // Circuit breaker: skip sources that have failed N consecutive times to
  // prevent burning Haiku calls on structurally-broken sources every cron fire.
  if (isEnrichmentCircuitOpen(meta)) return out;

  const thinChars = parsePositiveInt(env.FEED_THIN_CHARS, DEFAULT_FEED_THIN_CHARS);
  const cap = parsePositiveInt(env.FEED_ENRICH_MAX_PER_FIRE, DEFAULT_ENRICH_MAX_PER_FIRE);

  const candidates = rawReleases
    .map((raw, index) => ({ raw, index }))
    .filter(({ raw }) => raw.url && isThinItem(raw, { thinChars }) && isEnrichableUrl(raw.url));
  if (candidates.length === 0) return out;

  const urls = [...new Set(candidates.map((c) => c.raw.url!))];
  const existing = new Set<string>();
  for (let i = 0; i < urls.length; i += IN_ARRAY_CHUNK_SIZE) {
    const chunk = urls.slice(i, i + IN_ARRAY_CHUNK_SIZE);
    // oxlint-disable-next-line no-await-in-loop -- chunked to respect D1 bind-param cap
    const rows = await db
      .select({ url: releases.url })
      .from(releases)
      .where(and(eq(releases.sourceId, source.id), inArray(releases.url, chunk)));
    for (const r of rows) if (r.url) existing.add(r.url);
  }

  const fresh = candidates.filter(({ raw }) => !existing.has(raw.url!)).slice(0, cap);
  // No fresh items this fire → no enrichment attempt was made. Leave the
  // circuit-breaker counter untouched: a source that simply had nothing new
  // and thin to enrich must not accrue "failures".
  if (fresh.length === 0) return out;

  let anySuccess = false;
  for (const { raw, index } of fresh) {
    const attemptedAt = new Date().toISOString();
    // oxlint-disable-next-line no-await-in-loop -- bounded by `cap`; sequential keeps cost predictable
    const res = await deps.enrichFn({
      url: raw.url!,
      title: raw.title,
      summary: raw.content ?? "",
    });
    // Treat enriched-without-content as a failure (mirrors runEnrichBackfill):
    // only mark succeeded when there's a real body to apply.
    if (res.status === "enriched" && res.content) {
      anySuccess = true;
      out.set(index, {
        content: res.content,
        media: res.media,
        marker: { attemptedAt, succeeded: true, via: res.via },
      });
    } else {
      out.set(index, { marker: { attemptedAt, succeeded: false } });
    }
  }

  // Persist the per-source breaker state. Any success this fire resets the
  // counter to 0 (and clears any tripped state); an all-fail fire increments
  // it. The write only runs when at least one attempt was made (guarded
  // above), so a source with nothing to enrich never trips the breaker. Merge
  // against the freshly-read row so a concurrent metadata edit isn't clobbered
  // wholesale; fail-open — a write error must not lose the enriched bodies the
  // caller is about to apply.
  try {
    await persistEnrichmentBreakerState(db, source.id, anySuccess);
  } catch (err) {
    logEvent("warn", {
      component: "feed-enrich",
      event: "breaker-writeback-failed",
      sourceId: source.id,
      err,
    });
  }
  return out;
}

/**
 * Re-read the source's current metadata, fold in the next `enrichment` block
 * (increment on all-fail, reset on any success), and write it back to the
 * `sources` row. Re-reading inside the function keeps the merge against the
 * latest persisted metadata rather than the possibly-stale in-memory copy the
 * caller held, so an unrelated metadata field written earlier in the same fire
 * isn't dropped.
 */
async function persistEnrichmentBreakerState(
  db: ReturnType<typeof drizzle>,
  sourceId: string,
  succeeded: boolean,
): Promise<void> {
  const [row] = await db
    .select({ metadata: sources.metadata })
    .from(sources)
    .where(eq(sources.id, sourceId));
  const current = row ? getSourceMeta({ metadata: row.metadata } as Source) : {};
  const merged: SourceMetadata = {
    ...current,
    enrichment: nextEnrichmentMetadata(current.enrichment, succeeded),
  };
  await db
    .update(sources)
    .set({ metadata: JSON.stringify(merged) })
    .where(eq(sources.id, sourceId));
}
