import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { sources } from "@buildinternet/releases-core/schema";
import { getSourceMeta } from "@releases/adapters/source-meta.js";
import { createFirecrawlClient, type FirecrawlClient } from "@releases/adapters/firecrawl.js";
import { addedContentFromDiff } from "@releases/adapters/firecrawl-diff.js";
import { constantTimeEqual } from "@buildinternet/releases-core/api-token";
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
    "Admin-only. Reconciles the Firecrawl monitor for the source (typed `src_…` ID): the body (`enabled`, `schedule`, `proxy`, `goal`) is merged into `metadata.firecrawl`, then enabling creates the monitor and disabling deletes it. `schedule`/`proxy`/`goal` are applied when the monitor is first created; on an existing monitor only the webhook (URL + token + sourceId) is reconciled, so frequency/proxy/goal changes made in the Firecrawl dashboard are authoritative and never overwritten. Auth inherited from `publicReadAuthMiddleware`'s non-SAFE_METHODS branch — Bearer token required.",
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

// ---------------------------------------------------------------------------
// Phase 2: inbound webhook receiver
// The `integrations` namespace is in neither `publicReadRoutes` nor
// `adminRoutes`, so no middleware runs — the handler self-authenticates via
// a constant-time token comparison to prevent timing-oracle attacks.
// ---------------------------------------------------------------------------

interface FirecrawlPageEvent {
  type?: string;
  metadata?: { sourceId?: string };
  data?: Array<{
    checkId?: string;
    url?: string;
    status?: string;
    judgment?: { meaningful?: boolean; confidence?: string };
    diff?: { text?: string; json?: unknown };
  }>;
}

firecrawlRoutes.post("/integrations/firecrawl/webhook", async (c) => {
  const env = c.env as Env["Bindings"];

  // Auth: verify token BEFORE any DB work so we never leak whether a source
  // exists to an unauthenticated caller.
  const secret = await getSecret(env.FIRECRAWL_WEBHOOK_SECRET);
  const token = c.req.header("X-Firecrawl-Token") ?? "";
  if (!secret || !constantTimeEqual(token, secret)) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const body = (await c.req.json().catch(() => ({}))) as FirecrawlPageEvent;
  const sourceId = body.metadata?.sourceId;
  if (!sourceId) return c.json({ ok: true, skipped: "no_source_id" });

  const db = createDb(env.DB);
  const [source] = await db.select().from(sources).where(eq(sources.id, sourceId)).limit(1);
  const fc = source ? getSourceMeta(source).firecrawl : undefined;
  if (!source || !fc?.enabled) {
    logEvent("info", {
      component: "firecrawl-webhook",
      event: "skip-unknown-source",
      sourceId,
    });
    return c.json({ ok: true, skipped: "unknown_or_disabled" });
  }

  // Static per-source toggle — compute once, not per page.
  const judgeOn = fc.judgeEnabled !== false;

  // Set when a page's spawn genuinely failed (not a benign duplicate). Such a
  // page leaves its KV gate clean; we return a non-2xx at the end so Firecrawl
  // redelivers the batch (it retries on non-2xx with 1m/5m/15m backoff, 3x).
  let retryable = false;

  for (const page of body.data ?? []) {
    const { checkId, url, status, judgment } = page;
    if (!checkId || !url || !status) continue;

    // Idempotency: skip if this checkId+url combo was already processed.
    const key = `firecrawl:webhook:${checkId}:${url}`;
    if (env.LATEST_CACHE && (await env.LATEST_CACHE.get(key))) continue;

    // Cost gate.
    // `new` — always ingest (first time we've seen the page, data has value).
    // `changed` — ingest when judging is off, judgment is absent (fail-open —
    //   never silently drop a real change), or judgment says meaningful.
    // `same` / `removed` / `error` — no-op.
    const meaningful = judgment?.meaningful;
    const enqueue =
      status === "new" ||
      (status === "changed" && (!judgeOn || meaningful === true || meaningful === undefined));

    if (!enqueue) {
      logEvent("info", {
        component: "firecrawl-webhook",
        event: "gate-skip",
        sourceId,
        status,
        meaningful: meaningful ?? null,
      });
      continue;
    }

    // On a `changed` event Firecrawl hands us the diff; extracting just the
    // added lines keeps steady-state ingests small and skips the (paid) full
    // re-scrape. `new`/baseline events (and any diff that adds nothing) carry
    // no delta, so the workflow scrapes the page and windows it at extract time.
    const diffTextLen = page.diff?.text?.length ?? 0;
    const delta = addedContentFromDiff(page.diff?.text ?? "") || undefined;

    // No binding (pre-Phase-2 deploy state) → nothing to enqueue. Skip without
    // writing the KV gate so a later deploy can still process a redelivery.
    if (!env.FIRECRAWL_INGEST_WORKFLOW) continue;

    try {
      await env.FIRECRAWL_INGEST_WORKFLOW.create({
        id: `fc-${checkId}`,
        params: { sourceId, url, checkId, status, delta },
      });
    } catch (err) {
      // create() throws BOTH when the deterministic id already exists
      // (redelivery / double-fire — benign, the work is already durable) AND on
      // a transient API failure (CF Workflows blip, quota), with no stable error
      // code to tell them apart. Probe with get(): it resolves iff the instance
      // exists. Exists → benign duplicate; fall through and seal the KV gate.
      // Absent → the spawn truly failed; leave the gate clean and flag the batch
      // retryable so we return a non-2xx and Firecrawl redelivers. Without this
      // the old code swallowed every error, returned 200, and the KV key written
      // up front locked out any retry of this (checkId,url) for the TTL (#1287).
      const instanceExists = await env.FIRECRAWL_INGEST_WORKFLOW.get(`fc-${checkId}`)
        .then(() => true)
        .catch(() => false);
      if (!instanceExists) {
        retryable = true;
        logEvent("error", {
          component: "firecrawl-webhook",
          event: "spawn-failed",
          sourceId,
          checkId,
          err: err instanceof Error ? { name: err.name, message: err.message } : String(err),
        });
        continue;
      }
      logEvent("info", {
        component: "firecrawl-webhook",
        event: "spawn-duplicate",
        sourceId,
        checkId,
      });
    }

    // Idempotency gate: written ONLY after a confirmed durable spawn (fresh or
    // pre-existing), never on a transient failure (those `continue` above), so a
    // failed spawn can be retried instead of being silently locked out for the
    // KV TTL. Cross-request dedup is anchored by the deterministic instance id
    // `fc-${checkId}` and DB-level RELEASE_URL_UPSERT — this key is a fast-path
    // optimization, not the source of truth.
    await env.LATEST_CACHE?.put(key, "1", { expirationTtl: 3600 });

    logEvent("info", {
      component: "firecrawl-webhook",
      event: "enqueued",
      sourceId,
      checkId,
      status,
      // Diagnostics for the diff → delta fast path. `path: "rescrape"` with
      // diffTextLen > 0 means the diff carried no extractable added content, so
      // the workflow falls back to a full-page re-scrape + window — the signal
      // that an unexpected diff shape (or genuinely added-nothing change) is in
      // play, queryable in one shot instead of pulling the raw payload.
      diffTextLen,
      deltaLen: delta?.length ?? 0,
      path: delta ? "delta" : "rescrape",
    });
  }

  // A genuine spawn failure on any page → tell Firecrawl the batch wasn't fully
  // handled so it redelivers. Pages that DID spawn already wrote their KV gate
  // (and hold a durable instance id), so the redelivery skips them and only the
  // failed page is reprocessed.
  if (retryable) return c.json({ ok: false, error: "spawn_failed" }, 503);

  return c.json({ ok: true });
});
