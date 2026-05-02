/**
 * IndexNow ping for releases.sh.
 *
 * Posts changed URLs to the public aggregator at api.indexnow.org, which
 * fans out to every participating engine (Bing, Yandex, Seznam, Naver, …).
 * One ownership file at https://releases.sh/{INDEXNOW_KEY}.txt — served by
 * `web/src/proxy.ts` — proves we control the host.
 *
 * Fire-and-forget by design: callers wrap us in `ctx.waitUntil(...)`. Every
 * failure logs and returns; never throws into the request path.
 *
 * Per-release URLs (`/release/...`) are intentionally out of scope today —
 * see https://github.com/buildinternet/releases/issues/649. We currently
 * notify only the org page, the source page, and (when present) the
 * product page, since those are the surfaces whose `lastmod` actually
 * shifted as a result of the new releases.
 */

interface SecretBindingLike {
  get(): Promise<string | undefined>;
}

export interface IndexNowEnv {
  INDEXNOW_ENABLED?: string;
  INDEXING_DISABLED?: string;
  INDEXNOW_KEY?: SecretBindingLike;
  WEB_BASE_URL?: string;
}

export interface IndexNowSource {
  slug: string;
  orgSlug: string | null;
  productSlug: string | null;
  isHidden: boolean | null;
  discovery: "curated" | "agent" | "on_demand";
}

const INDEXNOW_ENDPOINT = "https://api.indexnow.org/IndexNow";
const DEFAULT_BASE_URL = "https://releases.sh";

export interface SubmitOptions {
  nReleases: number;
  source: IndexNowSource;
  fetchImpl?: typeof fetch;
}

export interface SubmitResult {
  status: "skipped" | "submitted" | "error";
  reason?: string;
  httpStatus?: number;
}

export async function submitToIndexNow(
  env: IndexNowEnv,
  opts: SubmitOptions,
): Promise<SubmitResult> {
  const base = `[indexnow] source=${opts.source.slug}`;

  if (env.INDEXNOW_ENABLED !== "true") return logSkip(base, "flag_off");
  if (env.INDEXING_DISABLED === "true") return logSkip(base, "indexing_disabled");
  if (!env.INDEXNOW_KEY) return logSkip(base, "no_key_binding");
  if (opts.nReleases <= 0) return logSkip(base, "no_releases");
  if (opts.source.isHidden) return logSkip(base, "source_hidden");
  if (opts.source.discovery === "on_demand") return logSkip(base, "discovery_on_demand");

  const baseUrl = env.WEB_BASE_URL ?? DEFAULT_BASE_URL;
  const urls = buildUrls(baseUrl, opts.source);
  if (urls.length === 0) return logSkip(base, "no_urls");

  const key = await env.INDEXNOW_KEY.get();
  if (!key) return logSkip(base, "key_unset");

  const payload = { host: new URL(baseUrl).host, key, urlList: urls };
  const fetchImpl = opts.fetchImpl ?? fetch;

  try {
    const res = await fetchImpl(INDEXNOW_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
    });
    const ok = res.status >= 200 && res.status < 300;
    console.info(
      `${base} action=submitted ok=${ok} http_status=${res.status} n_urls=${urls.length} n_releases=${opts.nReleases}`,
    );
    return { status: ok ? "submitted" : "error", httpStatus: res.status };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`${base} action=submitted ok=false error="${msg}"`);
    return { status: "error", reason: msg };
  }
}

export function buildUrls(baseUrl: string, source: IndexNowSource): string[] {
  if (!source.orgSlug) return [];
  const root = baseUrl.replace(/\/$/, "");
  const out = [`${root}/${source.orgSlug}`, `${root}/${source.orgSlug}/${source.slug}`];
  if (source.productSlug) {
    out.push(`${root}/${source.orgSlug}/product/${source.productSlug}`);
  }
  return out;
}

function logSkip(base: string, reason: string): SubmitResult {
  console.info(`${base} action=skipped reason=${reason}`);
  return { status: "skipped", reason };
}

export interface NotifyDb {
  resolveOrgSlug(orgId: string): Promise<string | null>;
  resolveProductSlug(productId: string): Promise<string | null>;
}

export interface NotifyableSource {
  slug: string;
  orgId: string | null;
  productId: string | null;
  isHidden: boolean | null;
  discovery: "curated" | "agent" | "on_demand";
}

export async function notifyIndexNowForSource(
  env: IndexNowEnv,
  db: NotifyDb,
  source: NotifyableSource,
  nReleases: number,
): Promise<SubmitResult> {
  // Short-circuit before the slug lookups so disabled environments don't
  // hit D1 on every publish.
  if (env.INDEXNOW_ENABLED !== "true") {
    return logSkip(`[indexnow] source=${source.slug}`, "flag_off");
  }
  const orgSlug = source.orgId ? await db.resolveOrgSlug(source.orgId) : null;
  const productSlug = source.productId ? await db.resolveProductSlug(source.productId) : null;
  return submitToIndexNow(env, {
    nReleases,
    source: {
      slug: source.slug,
      orgSlug,
      productSlug,
      isHidden: source.isHidden,
      discovery: source.discovery,
    },
  });
}
