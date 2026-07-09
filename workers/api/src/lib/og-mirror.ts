/**
 * Ingest-time OpenGraph image mirroring (#2066).
 *
 * `release/[id]/opengraph-image` and its 13 sibling dynamic-segment routes
 * were the majority of the app's ISR write volume: an unbounded-cardinality
 * route family rendered once per crawl (100% cache miss in production
 * measurement) and never read from cache again. Rendering each release's OG
 * image exactly ONCE — here, right after its title/summary settle — and
 * mirroring it to `released-media` turns a per-crawl render into a static
 * object fetch, the same way `processMediaForR2` (`media-ingest.ts`) already
 * does for third-party release images.
 *
 * The web app cannot be rendered from a worker (`next/og` needs the Next.js
 * runtime), so this fetches the ALREADY-DEPLOYED `opengraph-image` route
 * (a real HTTP endpoint regardless of whether anything links to it) exactly
 * once, and PUTs the bytes to R2. Idempotent: a content hash over the fields
 * the image actually depends on (title, summary, org avatar, hero image) is
 * stamped into `releases.metadata.ogImage`, so a re-run against an unchanged
 * release is a no-op.
 *
 * Fail-open by design, matching `media-ingest.ts`: a slow/broken render must
 * never block ingest. Any fetch error, timeout, non-PNG response, oversized
 * response, or R2 `put` error is logged and skipped — the release keeps
 * flowing through the on-demand `opengraph-image` route as its OG image
 * (unchanged behavior; see `web/src/app/release/[id]/opengraph-image.tsx`).
 *
 * Only releases are mirrored in this pass (#2066 phase 1). The other 13
 * dynamic-segment OG routes (org, source, category, collection, tag,
 * updates/date) have no equivalent "ingest" moment and are left on the
 * existing render-per-request path; see the #2066 PR description for the
 * follow-up.
 */
import { eq, inArray, sql } from "drizzle-orm";
import { organizations, releases, sources } from "@buildinternet/releases-core/schema";
import { sha256Hex } from "@releases/core-internal/hash";
import { logEvent } from "@releases/lib/log-event";
import type { createDb } from "../db.js";

type Db = ReturnType<typeof createDb>;

const DEFAULT_TIMEOUT_MS = 8_000;
/** Satori-rendered 1200x630 PNGs run well under 1MB in practice; generous ceiling against a runaway render. */
const OG_MAX_BYTES = 3 * 1024 * 1024;
const OG_CONTENT_TYPE = "image/png";

export interface MirrorReleaseOgOptions {
  db: Db;
  /** The `released-media` R2 bucket binding (`env.MEDIA`). */
  bucket: R2Bucket;
  /** Absolute web origin, e.g. `releaseWebBase(env)`. */
  webBase: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  perItemTimeoutMs?: number;
}

export interface OgMirrorReport {
  attempted: number;
  mirrored: number;
  skippedUnchanged: number;
  failed: number;
}

export interface StoredOgImage {
  key: string;
  hash: string;
}

/**
 * Extract `{ key, hash }` from a release's stored `metadata` text blob.
 * Returns `null` for missing/malformed metadata or a malformed `ogImage` —
 * callers fall back to the on-demand route (never a broken URL).
 */
export function parseOgImageFromMetadata(
  metadata: string | null | undefined,
): StoredOgImage | null {
  if (!metadata) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const og = (parsed as Record<string, unknown>).ogImage;
  if (!og || typeof og !== "object") return null;
  const key = (og as Record<string, unknown>).key;
  const hash = (og as Record<string, unknown>).hash;
  if (typeof key !== "string" || !key || typeof hash !== "string" || !hash) return null;
  return { key, hash };
}

/** First image candidate's identifying string (`r2Key` if mirrored, else raw `url`), or null. */
function firstImageIdentity(rawMedia: string | null | undefined): string | null {
  if (!rawMedia) return null;
  let arr: unknown;
  try {
    arr = JSON.parse(rawMedia);
  } catch {
    return null;
  }
  if (!Array.isArray(arr)) return null;
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const m = item as Record<string, unknown>;
    if ((m.type ?? "image") !== "image") continue;
    const identity = m.r2Key ?? m.url;
    if (typeof identity === "string" && identity) return identity;
  }
  return null;
}

function computeOgHash(input: {
  title: string;
  summary: string | null;
  avatarUrl: string | null;
  heroImage: string | null;
}): string {
  return sha256Hex(JSON.stringify(input)).slice(0, 20);
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Render-once-and-mirror for a batch of release ids. Skips (does not count as
 * failed) any release whose computed hash matches what's already stored —
 * this makes the step safe to call again on `step.do` retry, and safe to call
 * on a release whose title/summary haven't changed since the last mirror.
 */
export async function mirrorReleaseOgImages(
  opts: MirrorReleaseOgOptions,
  releaseIds: string[],
): Promise<OgMirrorReport> {
  const report: OgMirrorReport = { attempted: 0, mirrored: 0, skippedUnchanged: 0, failed: 0 };
  if (releaseIds.length === 0) return report;

  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.perItemTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  const rows = await opts.db
    .select({
      id: releases.id,
      title: releases.title,
      titleGenerated: releases.titleGenerated,
      titleShort: releases.titleShort,
      summary: releases.summary,
      media: releases.media,
      metadata: releases.metadata,
      orgAvatarUrl: organizations.avatarUrl,
    })
    .from(releases)
    .innerJoin(sources, eq(sources.id, releases.sourceId))
    .leftJoin(organizations, eq(organizations.id, sources.orgId))
    .where(inArray(releases.id, releaseIds));

  for (const row of rows) {
    report.attempted++;
    try {
      const displayTitle = row.titleShort ?? row.titleGenerated ?? row.title;
      const heroImage = firstImageIdentity(row.media as string | null);
      const hash = computeOgHash({
        title: displayTitle,
        summary: row.summary,
        avatarUrl: row.orgAvatarUrl ?? null,
        heroImage,
      });

      const existing = parseOgImageFromMetadata(row.metadata as string | null);
      if (existing?.hash === hash) {
        report.skippedUnchanged++;
        continue;
      }

      const renderUrl = `${opts.webBase}/release/${row.id}/opengraph-image`;
      // eslint-disable-next-line no-await-in-loop -- sequential per-row keeps this a bounded, easy-to-reason ingest step
      const res = await fetchWithTimeout(renderUrl, timeoutMs, fetchImpl);
      if (!res || !res.ok) {
        report.failed++;
        continue;
      }
      const contentType = (res.headers.get("content-type") ?? "")
        .split(";")[0]
        .trim()
        .toLowerCase();
      if (contentType !== OG_CONTENT_TYPE) {
        report.failed++;
        continue;
      }
      // eslint-disable-next-line no-await-in-loop -- see above
      const buf = await res.arrayBuffer();
      if (buf.byteLength === 0 || buf.byteLength > OG_MAX_BYTES) {
        report.failed++;
        continue;
      }

      const key = `og/release/${row.id}-${hash}.png`;
      // eslint-disable-next-line no-await-in-loop -- see above
      await opts.bucket.put(key, buf, { httpMetadata: { contentType } });

      // eslint-disable-next-line no-await-in-loop -- see above
      await opts.db
        .update(releases)
        .set({
          metadata: sql`json_set(coalesce(${releases.metadata}, '{}'), '$.ogImage', json(${JSON.stringify(
            { key, hash },
          )}))`,
        })
        .where(eq(releases.id, row.id));

      report.mirrored++;
    } catch (err) {
      report.failed++;
      logEvent("warn", {
        component: "og-mirror",
        event: "mirror-failed",
        releaseId: row.id,
        err,
      });
    }
  }

  return report;
}
