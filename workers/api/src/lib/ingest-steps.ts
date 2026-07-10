/**
 * Shared ingest step primitives for the workflow ingest paths (#1946 phase 3).
 *
 * The poll path (`workflows/poll-and-fetch.ts`) and the Firecrawl webhook path
 * (`workflows/firecrawl-ingest.ts`) run the SAME post-insert side-effect chain —
 * summarize (`generate-content`) → embed (`embed-releases`) → purge the
 * latest-cache (`invalidate-latest-cache`). Historically each workflow inlined
 * its own copy, and they drifted (the firecrawl copy had embed/generate reversed
 * and no cache purge — fixed in #1955). Home the chain here so the two paths
 * can't diverge again, and so the webhook path no longer imports the 800-line
 * PollAndFetch workflow module just to reach `generateContentForReleases`.
 *
 * The `step.do` names emitted here are load-bearing: CF Workflows matches
 * completed steps by name on replay, so they must stay byte-identical to what
 * both workflows emitted before the extraction.
 *
 * Env typing: the helpers accept `PollAndFetchWorkflowEnv` (imported type-only,
 * so there is no runtime import cycle with the poll workflow module — the value
 * imports flow the other way: poll-and-fetch imports these definitions from
 * here). `FirecrawlIngestEnv` extends `PollAndFetchWorkflowEnv`, so both callers
 * satisfy it.
 */

import type { WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import { and, eq, inArray, sql } from "drizzle-orm";
import { organizations, products, releases, sources } from "@buildinternet/releases-core/schema";
import type { Source } from "@buildinternet/releases-core/schema";
import type { ReleaseComposition } from "@buildinternet/releases-core/composition";
import { buildCompositionMetadataSet } from "@releases/core-internal/composition-metadata";
import { summarizeEligibilityConds } from "@releases/core-internal/eligibility";
import { releaseCoverage } from "@releases/core-internal/schema-coverage.js";
import { logEvent } from "@releases/lib/log-event";
import { dbErrorLogFields } from "@releases/lib/db-errors";
import { summarizeRelease } from "@releases/ai-internal/release-content";
import { splitModelId } from "@releases/ai-internal/text-model";
import {
  qualifiesForBreakingClassification,
  isValidKind,
} from "@buildinternet/releases-core/kinds";
import type { BreakingLevel } from "@buildinternet/releases-core/breaking";
import { embedReleasesForSource, type FetchOneEnv } from "../cron/poll-fetch.js";
import { buildFetchOneEnv } from "../workflows/_fetch-env.js";
import { invalidateLatestCache, type InvalidationEnv } from "./latest-cache.js";
import { resolveSummarizeModel } from "./text-model.js";
import { IN_ARRAY_CHUNK_SIZE } from "./d1-limits.js";
import { logUsage } from "./usage-log.js";
// Type-only — erased at compile, so no runtime import cycle with the workflow
// module that imports the values below from here.
import type { PollAndFetchWorkflowEnv } from "../workflows/poll-and-fetch.js";

/**
 * Retry policies. Embed is the critical failure mode the poll workflow exists to
 * solve — give it plenty of room to ride out Voyage rate limits. Fetch retries
 * cover transient 5xx / network blips; permanent 4xx surfaces as
 * NonRetryableError downstream.
 *
 * Shared so every ingest workflow (poll, firecrawl, backfill) reuses the same
 * policies instead of re-declaring identical constants.
 */
export const RETRY_POLL = {
  retries: { limit: 2, delay: "5 seconds", backoff: "exponential" },
} satisfies WorkflowStepConfig;

export const RETRY_FETCH = {
  retries: { limit: 3, delay: "30 seconds", backoff: "exponential" },
  timeout: "5 minutes",
} satisfies WorkflowStepConfig;

export const RETRY_EMBED = {
  retries: { limit: 5, delay: "30 seconds", backoff: "exponential" },
  timeout: "5 minutes",
} satisfies WorkflowStepConfig;

// Per-row failures are caught + logged inside the step body, so retries are
// conservative; the `title_generated IS NULL` predicate on the UPDATE
// makes a step-level retry safe.
export const RETRY_GENERATE = {
  retries: { limit: 1, delay: "30 seconds", backoff: "exponential" },
  timeout: "10 minutes",
} satisfies WorkflowStepConfig;

/**
 * Project a workflow env down to the `FetchOneEnv` slice via the shared
 * {@link buildFetchOneEnv} (single source of truth for the forwarded bindings).
 * The result only flows through step closures, so it never lands in the
 * workflow's persisted state.
 */
export function resolveFetchEnv(env: PollAndFetchWorkflowEnv): Promise<FetchOneEnv> {
  return buildFetchOneEnv(env);
}

/**
 * Per-fire row cap. A typical fire is 0–3 rows; anything larger is almost
 * always a monorepo dump or first-onboard backfill, neither of which is a
 * useful target for the per-row LLM call. Bail loudly and let a deliberate
 * `scripts/generate-release-content.ts` invocation mop up if wanted.
 */
const MAX_AUTOGEN_ROWS_PER_FIRE = 20;

/**
 * Per-row body cap (chars). Haiku 4.5 input is $1/M tokens (~4 chars/token),
 * so 50k chars ≈ 12.5k tokens ≈ $0.013 per call before output. Above that we
 * skip the row — outlier bodies don't summarize well and they dominate cost.
 */
const MAX_AUTOGEN_BODY_CHARS = 50_000;

/**
 * Per-org opt-in: when the source's org has `auto_generate_content = true`
 * and the source isn't hidden, run freshly-inserted releases through Haiku
 * 4.5 to populate `title_generated` / `title_short` / `summary`. A source can
 * opt out individually via `metadata.summarize = false` (see
 * `summarizeNotOptedOut`) — useful for App Store apps whose notes are always
 * boilerplate. The opt-out lives in the SELECT predicate so it holds for the
 * partial-source `regenerate` caller in routes/workflows.ts too.
 *
 * Per-row exceptions log + continue so a single bad call can't pin the
 * workflow into a retry storm. The step itself only throws on outer-loop
 * failures (SELECT, client construction).
 */
export async function generateContentForReleases(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle override pattern; same as the rest of this workflow
  db: any,
  env: PollAndFetchWorkflowEnv,
  source: Source,
  insertedIds: string[],
  // `ignoreAutoGenerateGate` drops the org-level `auto_generate_content` opt-in
  // (for an explicit operator trigger that wants content regardless). The
  // per-source `metadata.summarize=false` opt-out is still honored — that's a
  // deliberate "never summarize this source" signal, not a rollout gate.
  opts: { ignoreAutoGenerateGate?: boolean } = {},
): Promise<number> {
  // Hidden sources skip AI features per existing convention.
  if (source.isHidden === true) return 0;

  // Order matters: SELECT before secret-store fetch. Most orgs are opted out,
  // and the empty-result path saves a Secrets Store round-trip per non-opted
  // source on every cron fire. The IN list is chunked for the D1 100-bind cap
  // (90 ids + 1 boolean = 91 binds per statement); a backfill or first-time
  // onboard can push insertedIds well past 90.
  type ContentRow = {
    id: string;
    title: string;
    version: string | null;
    content: string;
    url: string | null;
    orgSlug: string;
    sourceName: string;
    productName: string | null;
    // Raw `kind` text from source + parent product (free-text column), used to
    // gate breaking-change classification to developer-facing kinds (#1696).
    sourceKind: string | null;
    productKind: string | null;
  };
  const rows: ContentRow[] = [];
  for (let i = 0; i < insertedIds.length; i += IN_ARRAY_CHUNK_SIZE) {
    const chunk = insertedIds.slice(i, i + IN_ARRAY_CHUNK_SIZE);
    // Skip coverage-side rows: they're hidden from read paths by default, so
    // summarizing them is a pure waste. The LEFT JOIN keeps canonical and
    // unlinked rows; the IS NULL filter drops anything that's already linked
    // as coverage to another release.
    // eslint-disable-next-line no-await-in-loop -- D1 chunked SELECT (100 bind param limit)
    const chunkRows: ContentRow[] = await db
      .select({
        id: releases.id,
        title: releases.title,
        version: releases.version,
        content: releases.content,
        url: releases.url,
        orgSlug: organizations.slug,
        sourceName: sources.name,
        productName: products.name,
        sourceKind: sources.kind,
        productKind: products.kind,
      })
      .from(releases)
      .innerJoin(sources, eq(sources.id, releases.sourceId))
      .innerJoin(organizations, eq(organizations.id, sources.orgId))
      .leftJoin(products, eq(products.id, sources.productId))
      .leftJoin(releaseCoverage, eq(releaseCoverage.coverageId, releases.id))
      .where(
        and(
          inArray(releases.id, chunk),
          ...summarizeEligibilityConds({ ignoreAutoGate: opts.ignoreAutoGenerateGate }),
        ),
      );
    rows.push(...chunkRows);
  }

  if (rows.length === 0) return 0;

  if (rows.length > MAX_AUTOGEN_ROWS_PER_FIRE) {
    logEvent("warn", {
      component: "auto-generate-content",
      event: "row-cap-tripped",
      sourceSlug: source.slug,
      candidateCount: rows.length,
      cap: MAX_AUTOGEN_ROWS_PER_FIRE,
    });
    return 0;
  }

  // Provider/model decided here: Anthropic Haiku via gateway by default, or a
  // cheap OpenRouter model when `openrouter-enabled` is on + a model is configured.
  // Fail-open: null means no usable provider (no Anthropic key) — skip.
  const model = await resolveSummarizeModel(env);
  if (!model) return 0;

  const startedAt = Date.now();

  let skippedEmpty = 0;
  let skippedTooLarge = 0;
  let failed = 0;
  let totalTokens = 0;

  // Sequential LLM calls (cache warming + cost bounding depend on this), then
  // a single batched UPDATE pass at the end. Each UPDATE binds at most 5 values
  // (titleGenerated, titleShort, summary, optional compositionJson, id) →
  // chunk at 20 to stay under D1's 100-bind per-statement cap. WHERE
  // title_generated IS NULL preserves idempotency against step retry — and
  // unlike title_short, it survives the boilerplate-discard path (where
  // title_short is intentionally null) so eligibility doesn't re-pick those
  // rows on the next batch run. When composition is null we omit metadata SET
  // entirely so boilerplate
  // rows don't trigger a no-op D1 page write.
  const updates: {
    id: string;
    titleGenerated: string | null;
    titleShort: string | null;
    summary: string | null;
    composition: ReleaseComposition | null;
    breaking: BreakingLevel;
    migrationNotes: string | null;
    importance: number | null;
  }[] = [];

  for (const row of rows) {
    if ((row.content?.length ?? 0) > MAX_AUTOGEN_BODY_CHARS) {
      skippedTooLarge++;
      logEvent("warn", {
        component: "auto-generate-content",
        event: "body-cap-skip",
        releaseId: row.id,
        orgSlug: row.orgSlug,
        bodyChars: row.content.length,
        cap: MAX_AUTOGEN_BODY_CHARS,
      });
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop -- sequential per-row keeps cost bounded; typical fire is 0–3 rows
      const result = await summarizeRelease(model, {
        orgSlug: row.orgSlug,
        sourceName: row.sourceName,
        productName: row.productName,
        title: row.title,
        version: row.version,
        url: row.url,
        content: row.content,
      });
      totalTokens +=
        result.usage.input +
        result.usage.output +
        result.usage.cacheCreate +
        result.usage.cacheRead;
      // Only log rows we actually summarized; skipped rows short-circuit
      // before the model call so they consumed no tokens. logUsage is
      // fail-open, so a write error never aborts the summarization loop.
      if (!result.skipped) {
        // eslint-disable-next-line no-await-in-loop -- one write per row; bounded by MAX_AUTOGEN_ROWS_PER_FIRE
        await logUsage(
          db,
          {
            operation: "summarize",
            // usage_log.model historically stores the bare model id (e.g.
            // "claude-haiku-4-5") so Anthropic rollups stay continuous with the
            // batch path. The TextModel id is "<provider>:<model>"; strip the
            // provider tag via the shared parser (OpenRouter ids like "google/…"
            // carry no further colon, so the bare model is unambiguous and, while
            // the flag is off, reproduces today's value byte-for-byte).
            model: splitModelId(model.id).model,
            inputTokens: result.usage.input,
            outputTokens: result.usage.output,
            cacheReadTokens: result.usage.cacheRead,
            cacheWriteTokens: result.usage.cacheCreate,
            sourceId: source.id,
            releaseCount: 1,
          },
          "poll-and-fetch",
        );
      }
      if (result.skipped) {
        skippedEmpty++;
        continue;
      }

      // Breaking-change verdict (#1696) rides the SAME summarize call — no extra
      // request. Persist it only for developer-facing source kinds
      // (sdk/tool/platform/integration); consumer apps / docs / kind-less rows
      // keep the "unknown" default even though the model classified them.
      const rawKind = row.sourceKind ?? row.productKind ?? null;
      const resolvedKind = rawKind && isValidKind(rawKind) ? rawKind : null;
      const qualifies = qualifiesForBreakingClassification(resolvedKind);
      const breaking: BreakingLevel = qualifies ? result.breaking : "unknown";
      const migrationNotes = qualifies ? result.migrationNotes : null;

      updates.push({
        id: row.id,
        titleGenerated: result.title,
        titleShort: result.titleShort,
        summary: result.summary,
        composition: result.composition,
        breaking,
        migrationNotes,
        importance: result.importance,
      });
    } catch (err) {
      failed++;
      logEvent("warn", {
        component: "auto-generate-content",
        event: "generation-failed",
        releaseId: row.id,
        orgSlug: row.orgSlug,
        err,
      });
    }
  }

  let generated = 0;
  // Worst-case binds per UPDATE: titleGenerated, titleShort, summary, metadata,
  // breaking, migration_notes, importance, id = 8 → chunk at floor(100 / 8) = 12
  // to stay under D1's 100-bind per-statement cap. breaking/migration_notes are
  // only SET for classified rows; non-classified rows keep their "unknown"
  // default. importance is always SET (including null, when unclassified).
  const UPDATE_CHUNK_SIZE = 12;
  for (let i = 0; i < updates.length; i += UPDATE_CHUNK_SIZE) {
    const chunk = updates.slice(i, i + UPDATE_CHUNK_SIZE);
    const statements = chunk.map((u) => {
      const metadataSet = buildCompositionMetadataSet(u.composition);
      return db
        .update(releases)
        .set({
          titleGenerated: u.titleGenerated,
          titleShort: u.titleShort,
          summary: u.summary,
          importance: u.importance,
          ...(metadataSet ? { metadata: metadataSet } : {}),
          ...(u.breaking !== "unknown"
            ? { breaking: u.breaking, migrationNotes: u.migrationNotes }
            : {}),
        })
        .where(and(eq(releases.id, u.id), sql`${releases.titleGenerated} IS NULL`));
    });
    try {
      // eslint-disable-next-line no-await-in-loop -- chunked batch; parallelism would exceed D1 limits
      await db.batch(statements as [(typeof statements)[number], ...typeof statements]);
      generated += chunk.length;
    } catch (err) {
      failed += chunk.length;
      logEvent("warn", {
        component: "auto-generate-content",
        event: "update-batch-failed",
        chunkOffset: i,
        chunkSize: chunk.length,
        err,
        ...dbErrorLogFields(err),
      });
    }
  }

  logEvent("info", {
    component: "auto-generate-content",
    event: "batch-summary",
    sourceSlug: source.slug,
    candidateCount: rows.length,
    generated,
    skippedEmpty,
    skippedTooLarge,
    failed,
    totalTokens,
    durationMs: Date.now() - startedAt,
  });

  return generated;
}

/**
 * Context for the post-insert side-effect steps. `db` is the shared drizzle
 * override pattern; `fetchEnv` is the projected {@link resolveFetchEnv} slice.
 */
export interface PostInsertStepCtx {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle override pattern; same as the workflows
  db: any;
  env: PollAndFetchWorkflowEnv;
  source: Source;
  insertedIds: string[];
  fetchEnv: FetchOneEnv;
}

/**
 * `generate-content` → `embed-releases`, in that order.
 *
 * Order is load-bearing: generate runs BEFORE embed so (a) the AI-generated
 * headline isn't embedded as a separate signal, and (b) the new `content_*`
 * fields land before the row reaches release-event observers. Both steps are
 * gated on `insertedIds.length > 0`; embed additionally requires the
 * `RELEASES_INDEX` binding.
 *
 * `onStep`, when provided, is invoked with each step name immediately before it
 * runs — the poll workflow uses it to keep its `currentStep` failure-context
 * tracker accurate; callers that don't track it (firecrawl) omit it.
 */
export async function runContentAndEmbedSteps(
  step: WorkflowStep,
  ctx: PostInsertStepCtx,
  onStep?: (name: string) => void,
): Promise<void> {
  const { db, env, source, insertedIds, fetchEnv } = ctx;
  if (insertedIds.length === 0) return;

  onStep?.("generate-content");
  await step.do("generate-content", RETRY_GENERATE, async () => {
    await generateContentForReleases(db, env, source, insertedIds);
  });

  if (env.RELEASES_INDEX) {
    onStep?.("embed-releases");
    await step.do("embed-releases", RETRY_EMBED, async () => {
      await embedReleasesForSource(db, source, insertedIds, fetchEnv, { throwOnError: true });
    });
  }
}

/**
 * `invalidate-latest-cache` — purge the cached `/v1/releases/latest` shapes when
 * rows were actually inserted, so a freshly-detected release isn't served stale
 * until the 5-minute TTL. Per-source invalidation (KV writes are cheap +
 * idempotent). No-op when `insertedCount <= 0`.
 */
export async function runInvalidateLatestCacheStep(
  step: WorkflowStep,
  env: InvalidationEnv,
  source: Source,
  insertedCount: number,
  onStep?: (name: string) => void,
): Promise<void> {
  if (insertedCount <= 0) return;
  onStep?.("invalidate-latest-cache");
  await step.do("invalidate-latest-cache", async () => {
    await invalidateLatestCache(env, { nReleases: insertedCount, cause: source.id });
  });
}
