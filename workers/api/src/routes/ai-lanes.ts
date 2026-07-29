/**
 * POST /v1/ai/lanes/:lane — synchronous, on-demand invocation of exactly one
 * ingest-time AI lane (marketing classifier, summarize, feed-enrich) on exactly
 * one input.
 *
 * Why this exists: every one of these lanes is otherwise only reachable as a
 * side effect buried inside `fetchOne` (`workers/api/src/cron/poll-fetch.ts`).
 * The marketing classifier in particular only runs on URLs not already stored,
 * so it's structurally impossible to re-run it on anything already ingested.
 * Verifying a routing change to a lane (e.g. an OpenRouter model swap) would
 * otherwise mean waiting for a third party to publish something new. This
 * route calls the lane directly and reports back the provider/model that was
 * ACTUALLY resolved — that report IS the verification signal.
 *
 * THE NON-NEGOTIABLE CONSTRAINT: model resolution goes through the exact same
 * seam production ingest uses — `buildFetchOneEnv(c.env)` (see
 * `../workflows/_fetch-env.js`) feeding the matching `resolve*Model` from
 * `../lib/text-model.js`. A hand-built env here would defeat the entire point
 * of the endpoint (see issue #2171 — a hand-built env literal on the manual
 * source-fetch path forwarded zero AI-lane keys and caused three weeks of
 * silent misrouting + a six-day outage). `resolveTextModel` wraps the returned
 * model with `withUsageLogging`, so a call here emits the same `ai_usage`
 * Axiom event production does — don't suppress that.
 *
 * Bucket rationale: this follows the `/v1/evaluate` precedent (flat admin
 * namespace, synchronous single-input AI call) rather than `/v1/workflows/*`,
 * which is reserved for async job triggers returning `202 + instanceId`. Admin
 * namespaces are not subject to the OpenAPI coverage gate (that gate only
 * covers `publicReadRoutes`; see `scripts/check-openapi-coverage.ts`), so this
 * route carries no `describeRoute` schema.
 */
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { releases, sources, organizations } from "@buildinternet/releases-core/schema";
import { createDb } from "../db.js";
import type { Env } from "../index.js";
import { respondError } from "../lib/error-response.js";
import {
  ValidationError,
  NotFoundError,
  ServiceUnavailableError,
  UpstreamError,
} from "@releases/lib/releases-error";
import { logEvent } from "@releases/lib/log-event";
import { classifyProviderQuota } from "@releases/lib/provider-quota";
import { estimateCost } from "@releases/lib/anthropic-pricing";
import { splitModelId, type TextModelUsage } from "@releases/ai-internal/text-model";
import type { SourceMetadata } from "@releases/adapters/source-meta";
import { buildFetchOneEnv } from "../workflows/_fetch-env.js";
import {
  resolveMarketingModel,
  resolveSummarizeModel,
  resolveArticleExtractModel,
} from "../lib/text-model.js";
import {
  classifyMarketing,
  type MarketingClassifierInput,
} from "@releases/ai-internal/marketing-classifier";
import {
  summarizeRelease,
  type SummarizeReleaseInput,
} from "@releases/ai-internal/release-content";
import { extractArticle } from "@releases/ai-internal/article-extract";

export const aiLaneRoutes = new Hono<Env>();

const LANES = ["marketing", "summarize", "feed-enrich"] as const;
type Lane = (typeof LANES)[number];

/** Lane name used both as the `resolve*Model` `generationName` (production
 *  ai_usage/telemetry attribution) and as the `lane` field on the
 *  `provider-quota-exhausted` log event. Keep these in sync with
 *  `../lib/text-model.ts`'s `resolveTextModel` call sites. */
const GENERATION_NAME: Record<Lane, string> = {
  marketing: "marketing-classifier",
  summarize: "summarize-release",
  "feed-enrich": "feed-enrich",
};

interface LaneRequestBody {
  releaseId?: string;
  sourceId?: string;
  title?: string;
  content?: string;
  url?: string;
  apply?: boolean;
}

/** Row shape loaded when `releaseId` resolves. */
interface ResolvedRelease {
  id: string;
  sourceId: string;
  title: string;
  content: string;
  url: string | null;
  version: string | null;
}

/** Row shape loaded when a source is available (directly via `sourceId`, or
 *  transitively via the loaded release's `sourceId`). */
interface ResolvedSource {
  id: string;
  name: string;
  metadata: string | null;
  orgSlug: string | null;
}

async function loadRelease(
  db: ReturnType<typeof createDb>,
  releaseId: string,
): Promise<ResolvedRelease> {
  const rows = await db
    .select({
      id: releases.id,
      sourceId: releases.sourceId,
      title: releases.title,
      content: releases.content,
      url: releases.url,
      version: releases.version,
    })
    .from(releases)
    .where(eq(releases.id, releaseId));
  if (rows.length === 0) throw new NotFoundError("Release not found", { details: { releaseId } });
  return rows[0];
}

async function loadSource(
  db: ReturnType<typeof createDb>,
  sourceId: string,
): Promise<ResolvedSource> {
  const rows = await db
    .select({
      id: sources.id,
      name: sources.name,
      metadata: sources.metadata,
      orgSlug: organizations.slug,
    })
    .from(sources)
    .leftJoin(organizations, eq(sources.orgId, organizations.id))
    .where(eq(sources.id, sourceId));
  if (rows.length === 0) throw new NotFoundError("Source not found", { details: { sourceId } });
  return rows[0];
}

/** Parse the JSON metadata blob off a loaded source row — mirrors
 *  `@releases/adapters/source-meta`'s `getSourceMeta`, which only reads
 *  `source.metadata`, but avoids widening `ResolvedSource` to a full `Source`
 *  row just to satisfy that helper's parameter type. */
function parseSourceMeta(metadata: string | null): SourceMetadata {
  try {
    const raw = metadata ?? "{}";
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** Anthropic reports no cost on `TextModelUsage`; derive a list-price estimate
 *  the same way `../lib/text-model.ts`'s `laneCost` does for the production
 *  ai_usage log. OpenRouter's `costUsd` already rides the usage object. */
function resolveCostUsd(
  provider: string,
  model: string,
  usage: TextModelUsage,
): number | undefined {
  if (usage.costUsd !== undefined) return usage.costUsd;
  if (provider !== "anthropic") return undefined;
  return estimateCost(
    {
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheWriteTokens: usage.cacheCreate,
      cacheReadTokens: usage.cacheRead,
    },
    model,
  )?.totalUsd;
}

function usagePayload(provider: string, model: string, usage: TextModelUsage) {
  return {
    input: usage.input,
    output: usage.output,
    cacheCreate: usage.cacheCreate,
    cacheRead: usage.cacheRead,
    costUsd: resolveCostUsd(provider, model, usage),
  };
}

/**
 * Run a lane's model call through the same failure-observability path
 * production uses: on a thrown error, classify it via `classifyProviderQuota`
 * and — when it IS a quota/billing shutoff — emit the `provider-quota-exhausted`
 * event with this lane's name, matching `poll-fetch.ts`'s
 * `classifyMarketingForReleases` catch block. This endpoint participates in
 * the same Axiom alerting signal a quota outage on the real lane would trip.
 */
async function runLane<T>(lane: Lane, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const quota = classifyProviderQuota(err);
    if (quota) {
      logEvent("error", {
        component: "ai-lanes",
        event: "provider-quota-exhausted",
        lane: GENERATION_NAME[lane],
        provider: quota.provider,
        regainAccessAt: quota.regainAccessAt?.toISOString() ?? null,
        providerMessage: quota.message,
      });
    }
    logEvent("warn", {
      component: "ai-lanes",
      event: "lane-invocation-failed",
      lane: GENERATION_NAME[lane],
      err,
    });
    throw new UpstreamError(`${lane} lane invocation failed`, { cause: err });
  }
}

aiLaneRoutes.post("/ai/lanes/:lane", async (c) => {
  const laneParam = c.req.param("lane");
  if (!(LANES as readonly string[]).includes(laneParam)) {
    return respondError(
      c,
      new ValidationError(`Unknown lane "${laneParam}" — expected one of: ${LANES.join(", ")}`, {
        code: "bad_request",
      }),
    );
  }
  const lane = laneParam as Lane;

  let body: LaneRequestBody;
  try {
    body = (await c.req.json()) as LaneRequestBody;
  } catch {
    body = {};
  }

  const apply = body.apply === true;
  if (apply && !body.releaseId) {
    return respondError(
      c,
      new ValidationError(
        "apply: true requires releaseId — there is nothing to write back to for inline content",
        {
          code: "bad_request",
        },
      ),
    );
  }

  const db = createDb(c.env.DB);

  let release: ResolvedRelease | undefined;
  if (body.releaseId) {
    try {
      release = await loadRelease(db, body.releaseId);
    } catch (err) {
      return respondError(c, err);
    }
  }

  const sourceId = body.sourceId ?? release?.sourceId;
  let source: ResolvedSource | undefined;
  if (sourceId) {
    try {
      source = await loadSource(db, sourceId);
    } catch (err) {
      return respondError(c, err);
    }
  }

  // Inline fields override values loaded from releaseId — this is
  // deliberate: it's what lets an operator probe "what would the lane say
  // about this DIFFERENT title/content on this same stored release" without
  // mutating anything (apply stays false in that case, since it's a what-if).
  const resolvedTitle = body.title ?? release?.title;
  const resolvedContent = body.content ?? release?.content;
  const resolvedUrl = body.url ?? release?.url ?? null;

  const sourceName = source?.name ?? "Unknown source";
  const orgSlug = source?.orgSlug ?? "unknown";
  const marketingFilterHint = source
    ? parseSourceMeta(source.metadata).marketingFilterHint
    : undefined;

  // Route model resolution through the exact same seam production ingest
  // uses (see module header / issue #2171) — never hand-build this env.
  const fetchEnv = await buildFetchOneEnv(c.env);

  if (lane === "marketing") {
    if (!resolvedTitle) {
      return respondError(
        c,
        new ValidationError("title is required for the marketing lane (via releaseId or inline)", {
          code: "bad_request",
        }),
      );
    }
    const model = await resolveMarketingModel(fetchEnv);
    if (!model) {
      return respondError(
        c,
        new ServiceUnavailableError("No text-model provider configured for the marketing lane"),
      );
    }
    const input: MarketingClassifierInput = {
      sourceName,
      title: resolvedTitle,
      content: resolvedContent ?? "",
      url: resolvedUrl,
      hint: marketingFilterHint ?? null,
    };
    const verdict = await runLane(lane, () => classifyMarketing(model, input));
    const { provider, model: modelName } = splitModelId(model.id);

    let applied = false;
    if (apply && release) {
      await db
        .update(releases)
        .set({
          suppressed: verdict.isMarketing,
          suppressedReason: verdict.isMarketing ? `marketing_classifier:${verdict.reason}` : null,
        })
        .where(eq(releases.id, release.id));
      applied = true;
    }

    return c.json({
      lane,
      provider,
      model: modelName,
      applied,
      input,
      result: { isMarketing: verdict.isMarketing, reason: verdict.reason },
      usage: usagePayload(provider, modelName, verdict.usage),
    });
  }

  if (lane === "summarize") {
    if (!resolvedTitle || !resolvedContent) {
      return respondError(
        c,
        new ValidationError(
          "title and content are required for the summarize lane (via releaseId or inline)",
          {
            code: "bad_request",
          },
        ),
      );
    }
    const model = await resolveSummarizeModel(fetchEnv);
    if (!model) {
      return respondError(
        c,
        new ServiceUnavailableError("No text-model provider configured for the summarize lane"),
      );
    }
    const input: SummarizeReleaseInput = {
      orgSlug,
      sourceName,
      productName: null,
      title: resolvedTitle,
      version: release?.version ?? null,
      url: resolvedUrl,
      content: resolvedContent,
    };
    const result = await runLane(lane, () => summarizeRelease(model, input));
    const { provider, model: modelName } = splitModelId(model.id);

    let applied = false;
    if (apply && release && !result.skipped) {
      await db
        .update(releases)
        .set({
          titleGenerated: result.title,
          titleShort: result.titleShort,
          summary: result.summary,
          importance: result.importance,
        })
        .where(eq(releases.id, release.id));
      applied = true;
    }

    return c.json({
      lane,
      provider,
      model: modelName,
      applied,
      input,
      result: {
        title: result.title,
        titleShort: result.titleShort,
        summary: result.summary,
        composition: result.composition,
        breaking: result.breaking,
        migrationNotes: result.migrationNotes,
        importance: result.importance,
        skipped: result.skipped,
      },
      usage: usagePayload(provider, modelName, result.usage),
    });
  }

  // feed-enrich
  if (!resolvedContent) {
    return respondError(
      c,
      new ValidationError(
        "content (page markdown) is required for the feed-enrich lane (via releaseId or inline)",
        {
          code: "bad_request",
        },
      ),
    );
  }
  const model = await resolveArticleExtractModel(fetchEnv);
  if (!model) {
    return respondError(
      c,
      new ServiceUnavailableError("No text-model provider configured for the feed-enrich lane"),
    );
  }
  const input = { markdown: resolvedContent, title: resolvedTitle ?? "" };
  const result = await runLane(lane, () => extractArticle(model, input));
  const { provider, model: modelName } = splitModelId(model.id);

  let applied = false;
  if (apply && release && result.content.trim().length > 0) {
    await db.update(releases).set({ content: result.content }).where(eq(releases.id, release.id));
    applied = true;
  }

  return c.json({
    lane,
    provider,
    model: modelName,
    applied,
    input,
    result: { content: result.content },
    usage: usagePayload(provider, modelName, result.usage),
  });
});
