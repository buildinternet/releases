import { getReleaseHub } from "../utils.js";
import { buildReleaseEventPayloads, type InsertedReleaseRow } from "./build-event.js";
import { expandAndEnqueue } from "../webhooks/expand-and-enqueue.js";
import {
  loadFollowTargetsForUsers,
  matchFollowsScopedWebhookSubscriptions,
  matchWebhookSubscriptions,
} from "../webhooks/queries.js";
import { createDb } from "../db.js";
import { newLocalEventId } from "@buildinternet/releases-core/id";
import type { ReleaseEvent } from "./types.js";
import { logEvent } from "@releases/lib/log-event";

export interface PublishContext {
  src: {
    name: string;
    slug: string;
    orgId: string | null;
    sourceId: string;
    /** Source type — surfaced on the event so the live feed can show its icon. */
    type?: string;
    /** Owning product id, resolved to `{slug,name}` for the event payload. */
    productId?: string | null;
  };
  inserted: InsertedReleaseRow[];
}

/** Org/product context resolved at publish time so live events carry an avatar. */
interface ResolvedSourceContext {
  org: {
    slug: string;
    name: string;
    avatarUrl: string | null;
    githubHandle: string | null;
  } | null;
  product: { slug: string; name: string } | null;
}

/**
 * Resolve the owning org (with its GitHub handle for avatar fallback) and
 * product for a source, so brand-new live events render an avatar + org/product
 * the instant they arrive — matching the REST-backfilled rows. Best-effort: any
 * failure (or absent DB binding) yields nulls and the event still publishes.
 */
async function resolveSourceContext(
  db: D1Database | undefined,
  orgId: string | null,
  productId: string | null | undefined,
): Promise<ResolvedSourceContext> {
  if (!db) return { org: null, product: null };
  try {
    const [orgRow, productRow] = await Promise.all([
      orgId
        ? db
            .prepare(
              `SELECT o.slug, o.name, o.avatar_url AS avatarUrl,
                 (SELECT handle FROM org_accounts
                    WHERE org_id = o.id AND platform = 'github'
                    ORDER BY created_at, id LIMIT 1) AS githubHandle
               FROM organizations o WHERE o.id = ?`,
            )
            .bind(orgId)
            .first<{
              slug: string;
              name: string;
              avatarUrl: string | null;
              githubHandle: string | null;
            }>()
        : Promise.resolve(null),
      productId
        ? db
            .prepare(`SELECT slug, name FROM products WHERE id = ?`)
            .bind(productId)
            .first<{ slug: string; name: string }>()
        : Promise.resolve(null),
    ]);
    // The SELECTs alias columns to exactly the target shapes (`slug`, `name`,
    // `avatarUrl`, `githubHandle` / `slug`, `name`), so the rows are returned
    // verbatim — no re-spread needed.
    return { org: orgRow ?? null, product: productRow ?? null };
  } catch (err) {
    logEvent("warn", { component: "events", event: "resolve-source-context-failed", err });
    return { org: null, product: null };
  }
}

export interface PublishEnv {
  RELEASE_HUB: DurableObjectNamespace;
  WEBHOOK_DELIVERY_QUEUE?: Queue<unknown>;
  DB?: D1Database;
}

/**
 * Publish release.created events:
 *   1. To ReleaseHub (WebSocket fan-out + ring buffer).
 *   2. To webhook-delivery queue (per-subscription fan-out).
 *
 * Both branches are fire-and-forget. Caller already wraps this in
 * ctx.waitUntil(). Errors are logged, never thrown.
 */
export async function publishReleaseEvents(env: PublishEnv, ctx: PublishContext): Promise<void> {
  if (ctx.inserted.length === 0) return;
  const eventOwners = new Map<
    string,
    { orgId: string; sourceId: string; productId: string | null; releaseType: "feature" | "rollup" }
  >();
  if (ctx.src.orgId) {
    const productId = ctx.src.productId ?? null;
    for (const row of ctx.inserted) {
      eventOwners.set(row.id, {
        orgId: ctx.src.orgId,
        sourceId: ctx.src.sourceId,
        productId,
        releaseType: row.type ?? "feature",
      });
    }
  }

  const { org, product } = await resolveSourceContext(env.DB, ctx.src.orgId, ctx.src.productId);
  const payloads = buildReleaseEventPayloads({
    src: {
      name: ctx.src.name,
      slug: ctx.src.slug,
      type: ctx.src.type,
      org,
      product,
    },
    inserted: ctx.inserted,
  });
  // Consumer keys idempotency on release.id (X-Releases-Event-Id), not on seq.
  const ts = Date.now();
  const events: ReleaseEvent[] = payloads.map((p) => ({
    id: newLocalEventId(),
    seq: 0,
    ts,
    type: "release.created" as const,
    release: p,
  }));

  const hubPublish = (async () => {
    try {
      const res = await getReleaseHub(env).fetch(
        new Request("https://do/publish", {
          method: "POST",
          body: JSON.stringify({ events: payloads }),
          headers: { "Content-Type": "application/json" },
        }),
      );
      if (!res.ok) {
        const rawBody = await res.text().catch(() => "");
        const MAX_BODY_LEN = 2000;
        const truncated = rawBody.length > MAX_BODY_LEN;
        logEvent("warn", {
          component: "events",
          event: "publish-non-ok",
          httpStatus: res.status,
          body: truncated ? `${rawBody.slice(0, MAX_BODY_LEN)}…` : rawBody,
          bodyLength: rawBody.length,
          bodyTruncated: truncated,
        });
      }
    } catch (err) {
      logEvent("warn", {
        component: "events",
        event: "hub-publish-failed",
        err,
      });
    }
  })();

  const webhookFanout =
    env.WEBHOOK_DELIVERY_QUEUE && env.DB
      ? expandAndEnqueue({
          events,
          eventOwners,
          loadOrgSubscriptions: (orgIds) => matchWebhookSubscriptions(createDb(env.DB!), orgIds),
          loadFollowsSubscriptions: () => matchFollowsScopedWebhookSubscriptions(createDb(env.DB!)),
          loadFollowTargetsForUsers: (userIds) =>
            loadFollowTargetsForUsers(createDb(env.DB!), userIds),
          queue: env.WEBHOOK_DELIVERY_QUEUE,
        })
      : Promise.resolve();

  await Promise.all([hubPublish, webhookFanout]);
}
