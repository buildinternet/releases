/**
 * Admin preview for semantic alerts (#2304).
 *
 * Generates plausible changelog entries and writes them through
 * `ingestReleaseBatch` + `runBatchIngestEffects`, the same insert → publish →
 * webhook-fanout path production ingest uses. Rows are flagged
 * `metadata.semanticAlertDemo` so purge can find them.
 *
 * The dedicated demo org is visible on purpose: `GET /v1/me/feed` (the Phase 2
 * candidate pool) drops hidden orgs and sources. It is not featured, and both
 * the org and the source are fetch-paused so cron will not try to read the
 * placeholder URL. Omit `sourceId` to use it. An explicit source is required
 * to write anywhere else.
 *
 * Matching is follows-only. When `userId` is set on the dedicated demo org,
 * preview upserts that org follow before insert and publish so scoring has a
 * candidate pool. The follow stays after purge. An explicit source is not
 * auto-followed.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  organizations,
  releases,
  sources,
  type ReleaseType,
  type Source,
} from "@buildinternet/releases-core/schema";
import { newOrgId, newSourceId } from "@buildinternet/releases-core/id";
import {
  ConflictError,
  NotFoundError,
  RateLimitedError,
  ValidationError,
} from "@releases/lib/releases-error";
import { logEvent } from "@releases/lib/log-event";
import type { D1Db } from "../db.js";
import { user } from "../db/schema-auth.js";
import { addFollow } from "../queries/follows.js";
import { RELEASES_ID_IN_CHUNK_SIZE } from "./d1-limits.js";
import {
  ingestReleaseBatch,
  runBatchIngestEffects,
  type BatchEffectsEnv,
  type BatchIngestEnv,
} from "./release-batch-ingest.js";
import {
  matchSemanticAlertsForUser,
  type SemanticAlertMatchHit,
  type SemanticAlertMatchPreview,
} from "./semantic-alert-matcher.js";

export const SEMANTIC_ALERT_DEMO_ORG_SLUG = "semantic-alerts-demo";
export const SEMANTIC_ALERT_DEMO_SOURCE_SLUG = "preview";
export const SEMANTIC_ALERT_DEMO_TITLE_PREFIX = "[demo] ";
export const SEMANTIC_ALERT_DEMO_MAX_COUNT = 20;
export const SEMANTIC_ALERT_DEMO_DEFAULT_COUNT = 5;
/** Standing cap on the dedicated demo source. Explicit sources are not capped. */
export const SEMANTIC_ALERT_DEMO_SOURCE_CAP = 20;
export const SEMANTIC_ALERT_DEMO_METADATA_FLAG = "semanticAlertDemo";

const DEMO_SOURCE_URL = "https://demo.releases.invalid/changelog";
const COMPONENT = "semantic-alert-preview";

export interface DemoTemplate {
  theme: string;
  title: string;
  type: ReleaseType;
  content: string;
}

/**
 * Varied on purpose so a freeform alert like "Slack integrations with B2B
 * software" has both hits and near-misses to score.
 */
export const DEMO_TEMPLATES: readonly DemoTemplate[] = [
  {
    theme: "slack-b2b",
    title: "Slack integration for B2B workspace admins",
    type: "feature",
    content: [
      "Workspace admins can now connect Slack to the B2B plan and route account alerts to a shared channel.",
      "The app posts when a customer workspace invites a new seat, changes a billing owner, or requests SSO.",
      "Install it from the Slack app directory under the Business and Enterprise plans. Personal workspaces are unchanged.",
    ].join("\n\n"),
  },
  {
    theme: "slack-consumer",
    title: "Slack status sync for personal reminders",
    type: "feature",
    content: [
      "A personal Slack status can now mirror your focus timer.",
      "This is a consumer convenience: it does not post to shared channels and it is not available on organization-wide installs.",
    ].join("\n\n"),
  },
  {
    theme: "b2b-pricing",
    title: "Usage-based pricing on the Business plan",
    type: "feature",
    content: [
      "The Business plan now meters API calls and shared seats separately.",
      "Existing annual contracts keep their current rate until renewal. Self-serve teams see the new estimator in billing settings.",
      "A CSV of the last 90 days of usage is available for finance review.",
    ].join("\n\n"),
  },
  {
    theme: "marketing-webinar",
    title: "Webinar: the future of collaborative work",
    type: "feature",
    content: [
      "Join our live webinar next Thursday to hear the founder talk about culture, brand, and the year ahead.",
      "No product changes ship with this announcement. Register for a recording if you cannot attend.",
    ].join("\n\n"),
  },
  {
    theme: "bugfix",
    title: "Fixed a crash when exporting CSV",
    type: "rollup",
    content: [
      "Exporting a filtered activity report no longer crashes when a row has an empty assignee.",
      "Also fixed a timezone off-by-one on the weekly digest date header and a stuck spinner on the invite modal.",
    ].join("\n\n"),
  },
  {
    theme: "security-sso",
    title: "Patched SSO session fixation",
    type: "feature",
    content: [
      "SAML login now rotates the session id after the identity provider posts the assertion.",
      "Enterprise admins should expire outstanding sessions from the security page. No password reset is required.",
    ].join("\n\n"),
  },
  {
    theme: "api-bulk",
    title: "REST API: bulk invite endpoint",
    type: "feature",
    content: [
      "`POST /v1/members:batch` accepts up to 100 email addresses and returns per-row errors.",
      "The endpoint is idempotent on email. Rate limits match the existing members API.",
    ].join("\n\n"),
  },
  {
    theme: "ai-summary",
    title: "AI summaries in the activity feed",
    type: "feature",
    content: [
      "The activity feed can collapse a noisy day into a five-bullet summary.",
      "Summaries are generated on read and are not sent anywhere else. Turn the toggle off under preferences.",
    ].join("\n\n"),
  },
  {
    theme: "notion-sync",
    title: "Notion database sync for project briefs",
    type: "feature",
    content: [
      "A Notion database can now stay in sync with project briefs.",
      "The connection is one-way from Notion into the workspace. It does not post to Slack.",
    ].join("\n\n"),
  },
  {
    theme: "series-b",
    title: "We raised a Series B",
    type: "feature",
    content: [
      "We are excited to announce our Series B. Thank you to our investors, our team, and our community.",
      "This note is a company update. There is no product change, pricing change, or integration in this release.",
    ].join("\n\n"),
  },
  {
    theme: "scim",
    title: "SCIM provisioning and audit log export",
    type: "feature",
    content: [
      "Enterprise workspaces can provision and deprovision seats over SCIM 2.0.",
      "Audit log export now includes the actor, the target workspace, and the IdP group that granted access.",
      "Okta and Entra ID are the first supported identity providers.",
    ].join("\n\n"),
  },
  {
    theme: "deprecation",
    title: "Sunset of the v1 webhooks payload",
    type: "feature",
    content: [
      "The v1 webhook body will stop being delivered on March 1.",
      "v2 adds the organization id and a stable event id. Update signature verification before the cutoff.",
    ].join("\n\n"),
  },
];

export interface GeneratedDemoRelease {
  theme: string;
  title: string;
  content: string;
  type: ReleaseType;
  url: string;
  publishedAt: string;
}

export function hashSeed(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const next = items.slice();
  for (let i = next.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const swap = next[i]!;
    next[i] = next[j]!;
    next[j] = swap;
  }
  return next;
}

export function randomDemoSeed(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Deterministic title/theme order for `seed`. URLs carry a fresh nonce so repeats insert. */
export function generateDemoReleases(
  count: number,
  seed: string,
  sourceId: string,
): GeneratedDemoRelease[] {
  const rng = mulberry32(hashSeed(seed));
  const order = shuffle(DEMO_TEMPLATES, rng);
  const publishedAt = new Date().toISOString();
  const out: GeneratedDemoRelease[] = [];
  for (let i = 0; i < count; i++) {
    const template = order[i % order.length]!;
    const cycle = Math.floor(i / order.length);
    const title =
      cycle === 0
        ? `${SEMANTIC_ALERT_DEMO_TITLE_PREFIX}${template.title}`
        : `${SEMANTIC_ALERT_DEMO_TITLE_PREFIX}${template.title} (${cycle + 1})`;
    out.push({
      theme: template.theme,
      title,
      content: template.content,
      type: template.type,
      url: `https://demo.releases.invalid/semantic-alerts/${sourceId}/${template.theme}-${crypto.randomUUID()}`,
      publishedAt,
    });
  }
  return out;
}

export function demoMetadata(): string {
  return JSON.stringify({
    [SEMANTIC_ALERT_DEMO_METADATA_FLAG]: true,
    generator: "admin-preview",
  });
}

export function isSemanticAlertDemoMetadata(raw: string | null | undefined): boolean {
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed[SEMANTIC_ALERT_DEMO_METADATA_FLAG] === true;
  } catch {
    return false;
  }
}

const demoFlagSql = sql`json_extract(${releases.metadata}, '$.semanticAlertDemo') = 1`;

export interface PreviewSourceTarget {
  source: Source;
  orgSlug: string;
  orgHidden: boolean;
  orgFeatured: boolean;
  /** True when this row is the dedicated demo source, not an explicit target. */
  demo: boolean;
}

export interface SemanticAlertPreviewInput {
  count: number;
  /** `src_…` or `orgSlug/sourceSlug`. Omitted → dedicated demo source. */
  sourceRef?: string;
  userId?: string;
  seed?: string;
}

export interface SemanticAlertPreviewRelease {
  id: string;
  title: string;
  url: string;
  theme: string;
}

export interface SemanticAlertPreviewResult {
  source: {
    id: string;
    slug: string;
    name: string;
    orgId: string;
    orgSlug: string;
    demo: boolean;
    followsEligible: boolean;
  };
  /**
   * Org the operator would follow so these rows enter the candidate pool.
   * `ensured` is true when this request upserted that follow for `userId`
   * (dedicated demo org only). Purge does not remove it.
   */
  follow: { targetType: "org"; targetId: string; slug: string; ensured: boolean };
  seed: string;
  requested: number;
  inserted: number;
  published: number;
  releases: SemanticAlertPreviewRelease[];
  matcher: {
    status: "unavailable" | "skipped" | "scored" | "error";
    reason?: string;
    userId: string | null;
    matches: SemanticAlertMatchHit[];
  };
  cleanup: { method: "POST"; path: "/v1/admin/semantic-alerts/purge"; sourceId: string };
}

export interface SemanticAlertPurgeResult {
  deleted: number;
  sourceId: string | null;
}

type MatchFn = (
  db: D1Db,
  userId: string,
  rows: Array<{
    id: string;
    title: string;
    content: string;
    sourceId: string;
    orgId: string | null;
  }>,
  env: BatchIngestEnv & BatchEffectsEnv,
) => Promise<SemanticAlertMatchPreview>;

function isUniqueConflict(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed/i.test(msg);
}

async function ensureDemoOrg(db: D1Db) {
  const load = async () => {
    const [row] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.slug, SEMANTIC_ALERT_DEMO_ORG_SLUG))
      .limit(1);
    return row ?? null;
  };

  const existing = await load();
  if (existing) {
    if (existing.deletedAt) {
      throw new ConflictError(
        `Org slug "${SEMANTIC_ALERT_DEMO_ORG_SLUG}" is tombstoned. Pass an explicit sourceId.`,
        { code: "conflict" },
      );
    }
    if (!isSemanticAlertDemoMetadata(existing.metadata)) {
      throw new ConflictError(
        `Org slug "${SEMANTIC_ALERT_DEMO_ORG_SLUG}" exists and is not the semantic-alerts demo org. Pass an explicit sourceId.`,
        { code: "conflict" },
      );
    }
    return existing;
  }

  const now = new Date().toISOString();
  try {
    await db.insert(organizations).values({
      id: newOrgId(),
      slug: SEMANTIC_ALERT_DEMO_ORG_SLUG,
      name: "Semantic alerts demo",
      description:
        "Synthetic publisher for the admin semantic-alerts preview. Not a real company. Purge demo releases from Admin → Semantic alerts.",
      isHidden: false,
      featured: false,
      fetchPaused: true,
      tier: "tracked",
      discovery: "curated",
      metadata: demoMetadata(),
      createdAt: now,
      updatedAt: now,
    });
  } catch (err) {
    if (!isUniqueConflict(err)) throw err;
  }

  const created = await load();
  if (!created || created.deletedAt || !isSemanticAlertDemoMetadata(created.metadata)) {
    throw new ConflictError(
      `Could not create the dedicated demo org "${SEMANTIC_ALERT_DEMO_ORG_SLUG}".`,
      { code: "conflict" },
    );
  }
  return created;
}

async function ensureDemoSource(db: D1Db, orgId: string): Promise<Source> {
  const load = async () => {
    const [row] = await db
      .select()
      .from(sources)
      .where(
        and(
          eq(sources.orgId, orgId),
          eq(sources.slug, SEMANTIC_ALERT_DEMO_SOURCE_SLUG),
          isNull(sources.deletedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  };

  const existing = await load();
  if (existing) {
    if (!isSemanticAlertDemoMetadata(existing.metadata)) {
      throw new ConflictError(
        `Source "${SEMANTIC_ALERT_DEMO_ORG_SLUG}/${SEMANTIC_ALERT_DEMO_SOURCE_SLUG}" exists and is not a demo source. Pass an explicit sourceId.`,
        { code: "conflict" },
      );
    }
    return existing;
  }

  const now = new Date().toISOString();
  try {
    await db.insert(sources).values({
      id: newSourceId(),
      orgId,
      slug: SEMANTIC_ALERT_DEMO_SOURCE_SLUG,
      name: "Semantic alerts preview",
      type: "feed",
      url: DEMO_SOURCE_URL,
      isHidden: false,
      fetchPriority: "paused",
      discovery: "curated",
      metadata: demoMetadata(),
      createdAt: now,
    });
  } catch (err) {
    if (!isUniqueConflict(err)) throw err;
  }

  const created = await load();
  if (!created || !isSemanticAlertDemoMetadata(created.metadata)) {
    throw new ConflictError("Could not create the dedicated demo source.", { code: "conflict" });
  }
  return created;
}

async function resolveExplicitSource(db: D1Db, sourceRef: string): Promise<PreviewSourceTarget> {
  const ref = sourceRef.trim();
  let source: Source | null = null;
  if (ref.includes("/")) {
    const parts = ref.split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new ValidationError('sourceId must be "src_…" or "orgSlug/sourceSlug".', {
        code: "bad_request",
      });
    }
    const [orgSlug, sourceSlug] = parts;
    const [org] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(and(eq(organizations.slug, orgSlug), isNull(organizations.deletedAt)))
      .limit(1);
    if (!org) throw new NotFoundError(`Org "${orgSlug}" not found`);
    const [row] = await db
      .select()
      .from(sources)
      .where(
        and(eq(sources.orgId, org.id), eq(sources.slug, sourceSlug), isNull(sources.deletedAt)),
      )
      .limit(1);
    source = row ?? null;
  } else if (ref.startsWith("src_")) {
    const [row] = await db
      .select()
      .from(sources)
      .where(and(eq(sources.id, ref), isNull(sources.deletedAt)))
      .limit(1);
    source = row ?? null;
  } else {
    throw new ValidationError(
      'sourceId must be "src_…" or "orgSlug/sourceSlug". Omit it to use the dedicated demo source.',
      { code: "bad_request" },
    );
  }

  if (!source) throw new NotFoundError(`Source "${ref}" not found`);
  return attachOrg(db, source);
}

async function attachOrg(db: D1Db, source: Source): Promise<PreviewSourceTarget> {
  const [org] = await db
    .select({
      id: organizations.id,
      slug: organizations.slug,
      isHidden: organizations.isHidden,
      featured: organizations.featured,
      deletedAt: organizations.deletedAt,
      metadata: organizations.metadata,
    })
    .from(organizations)
    .where(eq(organizations.id, source.orgId))
    .limit(1);
  if (!org || org.deletedAt) throw new NotFoundError("Source org not found");
  const demo =
    org.slug === SEMANTIC_ALERT_DEMO_ORG_SLUG &&
    source.slug === SEMANTIC_ALERT_DEMO_SOURCE_SLUG &&
    isSemanticAlertDemoMetadata(org.metadata) &&
    isSemanticAlertDemoMetadata(source.metadata);
  return {
    source,
    orgSlug: org.slug,
    orgHidden: org.isHidden,
    orgFeatured: org.featured,
    demo,
  };
}

async function countDemoReleases(db: D1Db, sourceId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(releases)
    .where(and(eq(releases.sourceId, sourceId), demoFlagSql));
  return Number(row?.n ?? 0);
}

async function assertUser(db: D1Db, userId: string): Promise<void> {
  const [row] = await db.select({ id: user.id }).from(user).where(eq(user.id, userId)).limit(1);
  if (!row) throw new NotFoundError(`User "${userId}" not found`);
}

export async function resolvePreviewTarget(
  db: D1Db,
  sourceRef: string | undefined,
): Promise<PreviewSourceTarget> {
  if (!sourceRef) {
    const org = await ensureDemoOrg(db);
    const source = await ensureDemoSource(db, org.id);
    return {
      source,
      orgSlug: org.slug,
      orgHidden: org.isHidden,
      orgFeatured: org.featured,
      demo: true,
    };
  }
  return resolveExplicitSource(db, sourceRef);
}

export async function runSemanticAlertPreview(
  db: D1Db,
  env: BatchIngestEnv & BatchEffectsEnv,
  input: SemanticAlertPreviewInput,
  deps?: { match?: MatchFn },
): Promise<SemanticAlertPreviewResult> {
  if (input.userId) await assertUser(db, input.userId);

  const target = await resolvePreviewTarget(db, input.sourceRef);
  if (target.demo) {
    const existing = await countDemoReleases(db, target.source.id);
    if (existing + input.count > SEMANTIC_ALERT_DEMO_SOURCE_CAP) {
      throw new RateLimitedError(
        `Demo source already has ${existing} synthetic releases (cap ${SEMANTIC_ALERT_DEMO_SOURCE_CAP}). Purge before inserting more.`,
        {
          code: "limit_exceeded",
          details: {
            cap: SEMANTIC_ALERT_DEMO_SOURCE_CAP,
            existing,
            requested: input.count,
          },
        },
      );
    }
  }

  // Follows-only matching skips a release with no user_follows row. Upsert the
  // demo org follow before insert and publish so this request can score.
  // Explicit sources are left alone — preview must not follow a real org.
  let followEnsured = false;
  if (input.userId && target.demo) {
    await addFollow(db, input.userId, "org", target.source.orgId);
    followEnsured = true;
  }

  const seed = input.seed ?? randomDemoSeed();
  const generated = generateDemoReleases(input.count, seed, target.source.id);
  const ingested = await ingestReleaseBatch(db, env, target.source, {
    releases: generated.map((row) => ({
      title: row.title,
      content: row.content,
      url: row.url,
      publishedAt: row.publishedAt,
      type: row.type,
    })),
    enrichMode: false,
  });

  if (ingested.insertedIds.length > 0) {
    await db
      .update(releases)
      .set({ metadata: demoMetadata() })
      .where(inArray(releases.id, ingested.insertedIds));
  }

  await runBatchIngestEffects(db, env, target.source, ingested, {
    skipSummarize: true,
    skipEmbed: true,
  });

  const byTitle = new Map(generated.map((row) => [row.title, row]));
  const previewReleases: SemanticAlertPreviewRelease[] = [];
  if (ingested.insertedIds.length > 0) {
    const rows = await db
      .select({ id: releases.id, title: releases.title })
      .from(releases)
      .where(inArray(releases.id, ingested.insertedIds));
    for (const row of rows) {
      const planned = byTitle.get(row.title);
      previewReleases.push({
        id: row.id,
        title: row.title,
        url: planned?.url ?? "",
        theme: planned?.theme ?? "unknown",
      });
    }
  }

  const followsEligible = !target.orgHidden && target.source.isHidden !== true;
  let matcher: SemanticAlertPreviewResult["matcher"];
  if (!input.userId) {
    matcher = { status: "skipped", reason: "user_not_requested", userId: null, matches: [] };
  } else if (previewReleases.length === 0) {
    matcher = { status: "skipped", reason: "nothing_inserted", userId: input.userId, matches: [] };
  } else {
    const match = deps?.match ?? matchSemanticAlertsForUser;
    try {
      const scored = await match(
        db,
        input.userId,
        previewReleases.map((row) => ({
          id: row.id,
          title: row.title,
          content: byTitle.get(row.title)?.content ?? "",
          sourceId: target.source.id,
          orgId: target.source.orgId,
        })),
        env,
      );
      matcher = {
        status: scored.status,
        ...(scored.reason ? { reason: scored.reason } : {}),
        userId: input.userId,
        matches: scored.matches,
      };
    } catch (err) {
      logEvent("warn", {
        component: COMPONENT,
        event: "matcher-failed",
        userId: input.userId,
        sourceId: target.source.id,
        err: err instanceof Error ? err : String(err),
      });
      matcher = {
        status: "error",
        reason: "matcher_failed",
        userId: input.userId,
        matches: [],
      };
    }
  }

  if (target.orgFeatured) {
    logEvent("warn", {
      component: COMPONENT,
      event: "preview-on-featured-org",
      orgId: target.source.orgId,
      sourceId: target.source.id,
      count: input.count,
    });
  }

  logEvent("info", {
    component: COMPONENT,
    event: "preview-inserted",
    sourceId: target.source.id,
    orgId: target.source.orgId,
    demo: target.demo,
    requested: input.count,
    inserted: ingested.inserted,
    published: ingested.visiblePublishRows.length,
    ...(input.userId ? { userId: input.userId, followEnsured } : {}),
  });

  return {
    source: {
      id: target.source.id,
      slug: target.source.slug,
      name: target.source.name,
      orgId: target.source.orgId,
      orgSlug: target.orgSlug,
      demo: target.demo,
      followsEligible,
    },
    follow: {
      targetType: "org",
      targetId: target.source.orgId,
      slug: target.orgSlug,
      ensured: followEnsured,
    },
    seed,
    requested: input.count,
    inserted: ingested.inserted,
    published: ingested.visiblePublishRows.length,
    releases: previewReleases,
    matcher,
    cleanup: {
      method: "POST",
      path: "/v1/admin/semantic-alerts/purge",
      sourceId: target.source.id,
    },
  };
}

async function demoSourceId(db: D1Db): Promise<string | null> {
  const [org] = await db
    .select({
      id: organizations.id,
      metadata: organizations.metadata,
      deletedAt: organizations.deletedAt,
    })
    .from(organizations)
    .where(eq(organizations.slug, SEMANTIC_ALERT_DEMO_ORG_SLUG))
    .limit(1);
  if (!org || org.deletedAt || !isSemanticAlertDemoMetadata(org.metadata)) return null;
  const [source] = await db
    .select({ id: sources.id, metadata: sources.metadata })
    .from(sources)
    .where(
      and(
        eq(sources.orgId, org.id),
        eq(sources.slug, SEMANTIC_ALERT_DEMO_SOURCE_SLUG),
        isNull(sources.deletedAt),
      ),
    )
    .limit(1);
  if (!source || !isSemanticAlertDemoMetadata(source.metadata)) return null;
  return source.id;
}

export async function purgeSemanticAlertDemoReleases(
  db: D1Db,
  input: { sourceRef?: string; all?: boolean },
): Promise<SemanticAlertPurgeResult> {
  let sourceId: string | null = null;
  if (!input.all) {
    if (input.sourceRef) {
      const target = await resolveExplicitSource(db, input.sourceRef);
      sourceId = target.source.id;
    } else {
      sourceId = await demoSourceId(db);
      if (!sourceId) return { deleted: 0, sourceId: null };
    }
  }

  const where = sourceId ? and(eq(releases.sourceId, sourceId), demoFlagSql) : demoFlagSql;
  const rows = await db.select({ id: releases.id }).from(releases).where(where);
  let deleted = 0;
  for (let i = 0; i < rows.length; i += RELEASES_ID_IN_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + RELEASES_ID_IN_CHUNK_SIZE).map((row) => row.id);
    if (chunk.length === 0) continue;
    // oxlint-disable-next-line no-await-in-loop -- chunked delete under D1's bind cap
    const removed = await db.delete(releases).where(inArray(releases.id, chunk)).returning({
      id: releases.id,
    });
    deleted += removed.length;
  }

  logEvent("info", {
    component: COMPONENT,
    event: "preview-purged",
    deleted,
    ...(sourceId ? { sourceId } : { all: true }),
  });

  return { deleted, sourceId };
}
