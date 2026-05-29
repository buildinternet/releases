import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { sources } from "@buildinternet/releases-core/schema";
import { getSourceMeta } from "@releases/adapters/source-meta.js";
import { createFirecrawlClient, type FirecrawlClient } from "@releases/adapters/firecrawl.js";
import { getSecret } from "@releases/lib/secrets";
import { logEvent } from "@releases/lib/log-event";
import { createDb } from "../db.js";
import { resolveSourceFromContext } from "../utils.js";
import { validateJson } from "../lib/validate.js";
import { hideInProduction } from "../openapi.js";
import { syncFirecrawlMonitor } from "../lib/firecrawl-sync.js";
import type { Env } from "../index.js";

export const firecrawlRoutes = new Hono<Env>();

const SyncFirecrawlBodySchema = z.object({
  enabled: z.boolean().optional(),
  schedule: z.string().optional(),
  proxy: z.enum(["basic", "enhanced", "auto"]).optional(),
  goal: z.string().optional(),
});

// Admin/operator endpoint — hidden from the public OpenAPI spec like its sibling
// POST /sources/:slug/fetch; covered by the ALLOWLIST in check-openapi-coverage.ts.
const postFirecrawlSyncRoute = describeRoute({
  hide: hideInProduction,
  tags: ["Sources"],
  summary: "Sync a source's Firecrawl monitor",
  description:
    "Admin-only. Reconciles the Firecrawl monitor for the source (typed `src_…` ID) to match its desired state: the body (`enabled`, `schedule`, `proxy`, `goal`) is merged into `metadata.firecrawl`, then enabling creates/updates the monitor and disabling deletes it. Auth inherited from `publicReadAuthMiddleware`'s non-SAFE_METHODS branch — Bearer token required.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "Updated source metadata; the `firecrawl` block reflects the new monitor state.",
    },
  },
});

function webhookUrl(env: Env["Bindings"]): string {
  // ADMIN_BASE_URL is the API worker's own public origin (https://api.releases.sh),
  // the same self-referential binding used by routes/workflows.ts and
  // cron/scrape-agent-sweep.ts. WEB_BASE_URL points at the Next.js frontend
  // (https://releases.sh), where this path 404s — see Phase 2 webhook receiver.
  const base = env.ADMIN_BASE_URL ?? "https://api.releases.sh";
  return `${base.replace(/\/$/, "")}/v1/integrations/firecrawl/webhook`;
}

firecrawlRoutes.post(
  "/sources/:slug/firecrawl/sync",
  postFirecrawlSyncRoute,
  validateJson(SyncFirecrawlBodySchema),
  async (c) => {
    const env = c.env as Env["Bindings"] & { _firecrawlClientOverride?: FirecrawlClient };
    const db = createDb(env.DB);
    // Mirror POST /sources/:slug/fetch: resolves a typed `src_…` ID on the bare
    // path and throws BareSlugRejected for bare slugs (translated to a 400 by the
    // global onError). Source slugs are only unique per-org (#690/#698), so a raw
    // `eq(sources.slug, …)` lookup could resolve the wrong org's source.
    const source = await resolveSourceFromContext(c, db);
    if (!source) return c.json({ error: "not_found" }, 404);

    // Body is validated + typed by `validateJson` (malformed JSON / wrong types
    // → 400 before this handler runs), so a stray `proxy: 123` never reaches
    // metadata or the monitor spec.
    const body = c.req.valid("json");

    const meta = getSourceMeta(source);
    const merged = {
      ...meta,
      firecrawl: {
        ...(meta.firecrawl ?? { enabled: false }),
        enabled: body.enabled ?? meta.firecrawl?.enabled ?? false,
        ...(body.schedule !== undefined ? { schedule: body.schedule } : {}),
        ...(body.proxy !== undefined ? { proxy: body.proxy } : {}),
        ...(body.goal !== undefined ? { goal: body.goal } : {}),
      },
    };
    const sourceForSync = { ...source, metadata: JSON.stringify(merged) };

    // Resolve both secrets up front and fail symmetrically with a structured 500
    // when either is unbound, rather than letting a missing API key surface as a
    // generic unhandled-exception 500.
    const secret = await getSecret(env.FIRECRAWL_WEBHOOK_SECRET);
    if (!secret) return c.json({ error: "webhook_secret_unbound" }, 500);

    // In tests an injected `_firecrawlClientOverride` short-circuits the live
    // client; in production we build it from the resolved API key.
    let client = env._firecrawlClientOverride;
    if (!client) {
      const apiKey = await getSecret(env.FIRECRAWL_API_KEY);
      if (!apiKey) return c.json({ error: "api_key_unbound" }, 500);
      client = createFirecrawlClient({ apiKey });
    }

    const hadMonitor = Boolean(meta.firecrawl?.monitorId);
    const patch = await syncFirecrawlMonitor(sourceForSync, client, {
      webhookUrl: webhookUrl(env),
      webhookSecret: secret,
    });

    const finalMeta = { ...merged, ...patch };
    try {
      await db
        .update(sources)
        .set({ metadata: JSON.stringify(finalMeta) })
        .where(eq(sources.id, source.id));
    } catch (err) {
      // Compensation: if we just minted a NEW monitor but failed to persist its
      // id, delete it — an orphaned monitor keeps scraping (and billing Firecrawl
      // credits) with no local handle to find it again. Best-effort; rethrow the
      // original failure either way.
      const newId = finalMeta.firecrawl?.monitorId;
      if (!hadMonitor && newId) await client.deleteMonitor(newId).catch(() => {});
      throw err;
    }

    logEvent("info", {
      component: "firecrawl-sync",
      event: "synced",
      sourceId: source.id,
      slug: source.slug,
      enabled: finalMeta.firecrawl?.enabled ?? false,
      monitorId: finalMeta.firecrawl?.monitorId ?? null,
    });

    return c.json(finalMeta);
  },
);
