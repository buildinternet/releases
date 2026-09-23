/**
 * Admin-preview seam for scoring one user's semantic alerts against releases
 * (#2304 Phase 2). Production delivery still runs from `publishReleaseEvents`.
 * This path only reports scores for the admin response: no claim row, no email,
 * no webhook enqueue, no Analytics Engine points. Query text stays out of logs.
 */
import { and, eq, inArray, or, type SQL } from "drizzle-orm";
import { sources } from "@buildinternet/releases-core/schema";
import { chunkArray, IN_ARRAY_CHUNK_SIZE } from "@buildinternet/releases-core/d1-limits";
import {
  buildSemanticAlertState,
  matchSemanticAlerts,
  type SemanticAlertCandidate,
} from "@releases/ai-internal/semantic-alert-match";
import type { NoulBatchModel } from "@releases/ai-internal/decision-model";
import type { D1Db } from "../db.js";
import { userFollows } from "../db/schema-follows.js";
import { semanticAlerts } from "../db/schema-semantic-alerts.js";
import { resolveSemanticAlertModel, type SemanticAlertModelEnv } from "./model.js";

/**
 * One alert scored against one release. `probability` is the JEV selected-choice
 * score (P(true)). `matched` is probability >= the alert threshold.
 */
export interface SemanticAlertMatchHit {
  alertId: string;
  releaseId: string;
  probability: number | null;
  matched: boolean;
  threshold: number;
}

export interface SemanticAlertMatchPreview {
  /**
   * `scored` once the matcher ran (including an empty candidate set).
   * `unavailable` when the decision model cannot be built.
   */
  status: "unavailable" | "scored";
  reason?: string;
  matches: SemanticAlertMatchHit[];
}

/** Release text the matcher is allowed to see. Public changelog fields only. */
export interface SemanticAlertMatchRelease {
  id: string;
  title: string;
  content: string;
  sourceId: string;
  orgId: string | null;
}

export interface SemanticAlertMatchDeps {
  resolveModel?: (env: SemanticAlertModelEnv) => Promise<NoulBatchModel | null>;
  questionsPerCall?: number;
}

interface SourceAnchor {
  orgId: string | null;
  productId: string | null;
}

/**
 * Score one user's enabled alerts against the given releases. Follows-only
 * prefilter, one JEV call per release, multiple `noul` questions, fail closed.
 * Does not deliver. Callers that need delivery use `runSemanticAlertMatch`.
 */
export async function matchSemanticAlertsForUser(
  db: D1Db,
  userId: string,
  releases: SemanticAlertMatchRelease[],
  env: SemanticAlertModelEnv,
  deps?: SemanticAlertMatchDeps,
): Promise<SemanticAlertMatchPreview> {
  if (releases.length === 0) return { status: "scored", matches: [] };

  const alerts = await listUserDeliveryAlerts(db, userId);
  if (alerts.length === 0) return { status: "scored", matches: [] };

  const anchors = await loadSourceAnchors(
    db,
    releases.map((release) => release.sourceId),
  );
  const eligibleByRelease = new Map<string, SemanticAlertCandidate[]>();
  for (const release of releases) {
    const anchor = anchors.get(release.sourceId) ?? {
      orgId: release.orgId,
      productId: null,
    };
    const orgId = release.orgId ?? anchor.orgId;
    const productId = anchor.productId;
    // oxlint-disable-next-line no-await-in-loop -- one follow check per release
    const follows = await userFollowsAnchor(db, userId, orgId, productId);
    if (!follows) continue;
    eligibleByRelease.set(
      release.id,
      alerts.map((alert) => ({
        id: alert.id,
        query: alert.query,
        threshold: alert.threshold,
      })),
    );
  }
  if (eligibleByRelease.size === 0) return { status: "scored", matches: [] };

  const resolve = deps?.resolveModel ?? resolveSemanticAlertModel;
  const model = await resolve(env);
  if (!model) {
    return { status: "unavailable", reason: "model_unavailable", matches: [] };
  }

  const byAlert = new Map(alerts.map((alert) => [alert.id, alert]));
  const matches: SemanticAlertMatchHit[] = [];
  for (const release of releases) {
    const candidates = eligibleByRelease.get(release.id);
    if (!candidates || candidates.length === 0) continue;
    // oxlint-disable-next-line no-await-in-loop -- one JEV call per release
    const outcome = await matchSemanticAlerts(
      model,
      buildSemanticAlertState({
        sourceName: "preview",
        title: release.title,
        url: null,
        summary: null,
        content: release.content,
      }),
      candidates,
      deps?.questionsPerCall ? { questionsPerCall: deps.questionsPerCall } : undefined,
    );
    for (const decision of outcome.decisions) {
      const alert = byAlert.get(decision.alertId);
      if (!alert) continue;
      matches.push({
        alertId: decision.alertId,
        releaseId: release.id,
        probability:
          typeof decision.probability === "number" && Number.isFinite(decision.probability)
            ? decision.probability
            : null,
        matched: decision.matched,
        threshold: alert.threshold,
      });
    }
  }

  return { status: "scored", matches };
}

async function listUserDeliveryAlerts(
  db: D1Db,
  userId: string,
): Promise<Array<{ id: string; query: string; threshold: number }>> {
  const delivery = or(
    eq(semanticAlerts.deliverEmail, true),
    eq(semanticAlerts.deliverWebhook, true),
  );
  if (!delivery) return [];
  return db
    .select({
      id: semanticAlerts.id,
      query: semanticAlerts.query,
      threshold: semanticAlerts.threshold,
    })
    .from(semanticAlerts)
    .where(and(eq(semanticAlerts.userId, userId), eq(semanticAlerts.enabled, true), delivery));
}

async function loadSourceAnchors(
  db: D1Db,
  sourceIds: string[],
): Promise<Map<string, SourceAnchor>> {
  const out = new Map<string, SourceAnchor>();
  for (const chunk of chunkArray([...new Set(sourceIds)], IN_ARRAY_CHUNK_SIZE)) {
    if (chunk.length === 0) continue;
    // oxlint-disable-next-line no-await-in-loop -- D1 bind-budget chunks
    const rows = await db
      .select({
        id: sources.id,
        orgId: sources.orgId,
        productId: sources.productId,
      })
      .from(sources)
      .where(inArray(sources.id, chunk));
    for (const row of rows) {
      out.set(row.id, { orgId: row.orgId, productId: row.productId });
    }
  }
  return out;
}

async function userFollowsAnchor(
  db: D1Db,
  userId: string,
  orgId: string | null,
  productId: string | null,
): Promise<boolean> {
  const followMatch: SQL[] = [];
  if (orgId) {
    const clause = and(eq(userFollows.targetType, "org"), eq(userFollows.targetId, orgId));
    if (clause) followMatch.push(clause);
  }
  if (productId) {
    const clause = and(eq(userFollows.targetType, "product"), eq(userFollows.targetId, productId));
    if (clause) followMatch.push(clause);
  }
  if (followMatch.length === 0) return false;
  const followWhere = followMatch.length === 1 ? followMatch[0] : or(...followMatch);
  if (!followWhere) return false;
  const [row] = await db
    .select({ id: userFollows.id })
    .from(userFollows)
    .where(and(eq(userFollows.userId, userId), followWhere))
    .limit(1);
  return row != null;
}
