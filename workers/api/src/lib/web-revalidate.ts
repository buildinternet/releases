/**
 * On-demand ISR invalidation ping: API worker → web's `POST /api/revalidate`.
 *
 * Web's org/source/product pages are statically rendered with a 24h window. That
 * window is a backstop, not the freshness mechanism — this ping is. When a
 * release is ingested we tell web which pages changed, so they regenerate on the
 * write that actually changed them instead of on a timer. Time-based ISR is a
 * bad fit for a long tail of rarely-updated pages: it either regenerates pages
 * that did not change (the Vercel ISR-write bill) or leaves fresh releases
 * invisible, depending only on how the window was guessed.
 *
 * Fire-and-forget by design: callers wrap us in `ctx.waitUntil(...)`. Every
 * failure logs and returns; never throws into the ingest path. A dropped ping
 * costs at most one page staying stale until its backstop expires — which is
 * exactly what that backstop is for.
 *
 * Note on gating: `discovery === "on_demand"` is deliberately NOT a skip. Its
 * only prior use was keeping low-signal pages out of search-engine indexes,
 * which says nothing about whether the page's cached HTML is stale. An
 * on-demand source's pages still change and still need busting.
 */

import { logEvent } from "@releases/lib/log-event";

export interface SecretBindingLike {
  get(): Promise<string | undefined>;
}

export interface WebRevalidateEnv {
  WEB_SERVICE_KEY?: SecretBindingLike;
  WEB_BASE_URL?: string;
}

export interface RevalidateableSource {
  slug: string;
  orgId: string | null;
  productId: string | null;
  isHidden: boolean | null;
}

export interface RevalidateDb {
  resolveOrgSlug(id: string): Promise<string | null>;
  resolveProductSlug(id: string): Promise<string | null>;
}

export interface RevalidateResult {
  status: "skipped" | "revalidated" | "error";
  reason?: string;
  httpStatus?: number;
}

const DEFAULT_BASE_URL = "https://releases.sh";
const REVALIDATE_PATH = "/api/revalidate";
// This runs inside fetchOne()'s waitUntil and must not stretch the cron's
// per-source budget if web is slow or blackholed.
const PING_TIMEOUT_MS = 2000;
// Mirrors the web route's own cap (see web/src/lib/revalidate-request.ts) —
// enforced here too so a caller handing us an unexpectedly long list still
// sends a bounded request instead of relying on the other side to reject it.
const MAX_PATHS = 50;

function logSkip(sourceSlug: string, reason: string): RevalidateResult {
  logEvent("info", { component: "web-revalidate", event: "skipped", sourceSlug, reason });
  return { status: "skipped", reason };
}

/**
 * Shared POST-with-timeout mechanics for both revalidate shapes. `notifyWebRevalidate`
 * does NOT call `notifyWebRevalidatePaths` for its own request — only this low-level
 * piece is shared — because the two workers (API, web) deploy independently. Routing
 * the already-live per-source ping through the `{ paths }` body would create a
 * rolling-deploy window where an old worker's request and a new web's parser (or vice
 * versa) disagree, for a ping whose wire shape and log fields are otherwise stable and
 * unit-tested. Sharing just the fetch call removes the duplicate timeout/header wiring
 * without touching that contract.
 */
async function postRevalidate(
  baseUrl: string,
  secret: string,
  body: unknown,
  fetchImpl: typeof fetch,
): Promise<Response> {
  return fetchImpl(`${baseUrl}${REVALIDATE_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(PING_TIMEOUT_MS),
  });
}

export async function notifyWebRevalidate(
  env: WebRevalidateEnv,
  db: RevalidateDb,
  source: RevalidateableSource,
  nReleases: number,
  opts?: { fetchImpl?: typeof fetch },
): Promise<RevalidateResult> {
  const sourceSlug = source.slug;

  // Every gate that doesn't need a slug lookup runs before touching D1, so a
  // no-op publish doesn't burn queries.
  if (!env.WEB_SERVICE_KEY) return logSkip(sourceSlug, "no_secret_binding");
  if (nReleases <= 0) return logSkip(sourceSlug, "no_releases");
  // Hidden sources are filtered out of every public read path (`sources_visible`),
  // so neither their own page nor the org listing changed for an anonymous visitor.
  if (source.isHidden) return logSkip(sourceSlug, "source_hidden");
  if (!source.orgId) return logSkip(sourceSlug, "no_org");

  // Resolve phase gets its own try: a Secrets Store hiccup or a D1 blip here is
  // as likely as the ping failing, and an escaping rejection would be swallowed
  // whole by `Promise.allSettled` in runBatchIngestEffects — no log line, no
  // result, page silently stale until the backstop. Separate from the ping's
  // catch so `resolve-failed` and `ping-failed` stay distinguishable in Axiom;
  // one means we never got as far as calling web, the other means web didn't
  // answer.
  let secret: string | undefined;
  let orgSlug: string | null;
  let productSlug: string | null;
  try {
    secret = await env.WEB_SERVICE_KEY.get();
    if (!secret) return logSkip(sourceSlug, "secret_unset");

    orgSlug = await db.resolveOrgSlug(source.orgId);
    if (!orgSlug) return logSkip(sourceSlug, "no_org");
    productSlug = source.productId ? await db.resolveProductSlug(source.productId) : null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logEvent("warn", { component: "web-revalidate", event: "resolve-failed", sourceSlug, err });
    return { status: "error", reason: msg };
  }

  const baseUrl = (env.WEB_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const fetchImpl = opts?.fetchImpl ?? fetch;

  try {
    const res = await postRevalidate(
      baseUrl,
      secret,
      {
        orgSlug,
        sourceSlug: source.slug,
        ...(productSlug ? { productSlug } : {}),
      },
      fetchImpl,
    );

    const ok = res.status >= 200 && res.status < 300;
    logEvent(ok ? "info" : "warn", {
      component: "web-revalidate",
      event: "pinged",
      sourceSlug,
      orgSlug,
      ok,
      httpStatus: res.status,
      nReleases,
    });
    return { status: ok ? "revalidated" : "error", httpStatus: res.status };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logEvent("warn", { component: "web-revalidate", event: "ping-failed", sourceSlug, err });
    return { status: "error", reason: msg };
  }
}

export interface RevalidatePathsResult {
  status: "skipped" | "revalidated" | "error";
  reason?: string;
  httpStatus?: number;
}

function logPathsSkip(component: string, paths: string[], reason: string): RevalidatePathsResult {
  logEvent("info", { component, event: "skipped", paths, reason });
  return { status: "skipped", reason };
}

/**
 * Generalized sibling of `notifyWebRevalidate`: pings web with an explicit list of
 * paths instead of deriving them from a source/org/product triple. Used by callers
 * whose changed pages aren't source-shaped — e.g. the weekly collection digest cron
 * (`workers/api/src/cron/collection-summaries.ts`), which busts the homepage reel
 * and every collection page that just got a new digest.
 *
 * Same fire-and-forget contract as `notifyWebRevalidate`: gated on the same
 * WEB_SERVICE_KEY binding, same 2s timeout, never throws — every branch resolves to
 * a result the caller can log and move on from.
 */
export async function notifyWebRevalidatePaths(
  env: WebRevalidateEnv,
  paths: string[],
  opts?: { fetchImpl?: typeof fetch; component?: string },
): Promise<RevalidatePathsResult> {
  const component = opts?.component ?? "web-revalidate-paths";

  if (!env.WEB_SERVICE_KEY) return logPathsSkip(component, paths, "no_secret_binding");
  if (paths.length === 0) return logPathsSkip(component, paths, "no_paths");

  const capped = paths.length > MAX_PATHS ? paths.slice(0, MAX_PATHS) : paths;

  let secret: string | undefined;
  try {
    secret = await env.WEB_SERVICE_KEY.get();
    if (!secret) return logPathsSkip(component, capped, "secret_unset");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logEvent("warn", { component, event: "resolve-failed", paths: capped, err });
    return { status: "error", reason: msg };
  }

  const baseUrl = (env.WEB_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const fetchImpl = opts?.fetchImpl ?? fetch;

  try {
    const res = await postRevalidate(baseUrl, secret, { paths: capped }, fetchImpl);
    const ok = res.status >= 200 && res.status < 300;
    logEvent(ok ? "info" : "warn", {
      component,
      event: "pinged",
      paths: capped,
      ok,
      httpStatus: res.status,
    });
    return { status: ok ? "revalidated" : "error", httpStatus: res.status };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logEvent("warn", { component, event: "ping-failed", paths: capped, err });
    return { status: "error", reason: msg };
  }
}
