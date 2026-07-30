/**
 * Transport-free core of `POST /api/revalidate`.
 *
 * The API worker calls this when a release is ingested so the affected org,
 * source and product pages regenerate on the write that actually changed them,
 * instead of on a timer. That is what lets the page-level windows sit at the
 * 24h backstop in `lib/isr.ts` rather than a low value chosen to bound how
 * stale a changelog can look.
 *
 * Kept out of `app/api/revalidate/route.ts` for two reasons: Next only permits
 * a fixed set of exports from a route module, and taking `revalidate` as a
 * dependency lets the tests drive the whole contract without mocking
 * `next/cache` process-globally (see AGENTS.md on interface injection).
 */

import { verifyServiceKey } from "./service-auth";

export interface RevalidateDeps {
  /**
   * The shared API-worker → web channel key (`RELEASES_SERVICE_KEY`), NOT a
   * revalidate-specific secret — see `lib/service-auth.ts`. `undefined` when
   * unconfigured, which fails the request closed.
   */
  serviceKey: string | undefined;
  /** Injected `revalidatePath`. */
  revalidate: (path: string) => void;
}

interface RevalidateBody {
  orgSlug: string;
  sourceSlug?: string;
  productSlug?: string;
}

/**
 * Slugs are interpolated straight into a `revalidatePath()` argument, so they
 * must not be able to carry path syntax: `revalidatePath("/")` would evict the
 * entire ISR cache on every ingest, turning this endpoint into an amplifier for
 * the exact cost it exists to remove.
 */
const SAFE_SLUG = /^[a-z0-9][a-z0-9._-]*$/i;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function parseBody(raw: unknown): RevalidateBody | null {
  if (!raw || typeof raw !== "object") return null;
  const { orgSlug, sourceSlug, productSlug } = raw as Record<string, unknown>;
  if (typeof orgSlug !== "string" || !SAFE_SLUG.test(orgSlug)) return null;

  const out: RevalidateBody = { orgSlug };
  for (const [key, value] of [
    ["sourceSlug", sourceSlug],
    ["productSlug", productSlug],
  ] as const) {
    if (value === undefined || value === null) continue;
    if (typeof value !== "string" || !SAFE_SLUG.test(value)) return null;
    out[key] = value;
  }
  return out;
}

export async function handleRevalidateRequest(
  req: Request,
  deps: RevalidateDeps,
): Promise<Response> {
  const auth = verifyServiceKey(req, deps.serviceKey);
  if (!auth.ok) {
    return auth.reason === "not_configured"
      ? json({ error: "service_key_not_configured" }, 503)
      : json({ error: "unauthorized" }, 401);
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const body = parseBody(raw);
  if (!body) return json({ error: "invalid_body" }, 400);

  // Dedup: a single-product org often names its source and product the same, and
  // revalidating one path twice is a wasted write on the very budget we are here
  // to protect.
  const paths = [
    `/${body.orgSlug}`,
    ...(body.sourceSlug ? [`/${body.orgSlug}/${body.sourceSlug}`] : []),
    ...(body.productSlug ? [`/${body.orgSlug}/${body.productSlug}`] : []),
  ];
  const unique = [...new Set(paths)];

  for (const path of unique) deps.revalidate(path);

  return json({ revalidated: unique }, 200);
}
