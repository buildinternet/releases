/**
 * Score one publish batch against follows-scoped semantic alerts and deliver
 * matches (#2304 Phase 2).
 *
 * Flag off returns before any read or model call. Candidates are users who
 * follow the release's org or product and have an enabled alert with a
 * delivery preference. One JEV call per release (chunked) asks a noul question
 * per alert. Provider errors and a missing model notify nobody. A match row
 * is claimed before send so the same alert and release do not notify twice.
 *
 * Alert query text is passed to the model and, on a match, into the owner's
 * email. It is not written to logs or Analytics Engine.
 */
import { and, eq, inArray } from "drizzle-orm";
import { releases, webhookSubscriptions } from "@buildinternet/releases-core/schema";
import { chunkArray, IN_ARRAY_CHUNK_SIZE } from "@buildinternet/releases-core/d1-limits";
import { releaseWebBase } from "@buildinternet/releases-core/release-slug";
import {
  buildSemanticAlertState,
  matchSemanticAlerts,
  type SemanticAlertCandidate,
  type SemanticAlertDecision,
} from "@releases/ai-internal/semantic-alert-match";
import type { NoulBatchModel } from "@releases/ai-internal/decision-model";
import { FLAGS, flag, type FlagshipBinding } from "@releases/lib/flags";
import { logEvent } from "@releases/lib/log-event";
import type { ReleaseEvent } from "../events/types.js";
import { createDb, type AnyDb } from "../db.js";
import { user } from "../db/schema-auth.js";
import {
  claimSemanticAlertMatch,
  listClaimedSemanticAlertIds,
  listSemanticAlertCandidates,
  type SemanticAlertCandidateRow,
} from "../queries/semantic-alerts.js";
import { sendSemanticAlertEmail } from "../lib/semantic-alert-email.js";
import type { AuthEmailEnv } from "../auth/email.js";
import type { DeliveryMessage } from "../webhooks/types.js";
import { writeSemanticAlertPoint, type SemanticAlertDataset } from "./analytics.js";
import { resolveSemanticAlertModel, type SemanticAlertModelEnv } from "./model.js";

const QUEUE_BATCH_LIMIT = 100;

export interface SemanticAlertEnv extends SemanticAlertModelEnv, AuthEmailEnv {
  DB?: D1Database;
  FLAGS?: FlagshipBinding;
  SEMANTIC_ALERTS_ENABLED?: string;
  WEB_BASE_URL?: string;
  WEBHOOK_DELIVERY_QUEUE?: Queue<unknown>;
  RELEASE_CLASSIFICATIONS_AE?: SemanticAlertDataset;
}

export interface SemanticAlertMatchInput {
  sourceName: string;
  sourceId: string;
  orgId: string | null;
  productId: string | null;
  releases: Array<{ id: string; event: ReleaseEvent }>;
}

export interface SemanticAlertMatchDeps {
  resolveModel?: (env: SemanticAlertModelEnv) => Promise<NoulBatchModel | null>;
  /** Test seam. Production uses the module default (12). */
  questionsPerCall?: number;
}

interface ReleaseBody {
  id: string;
  title: string;
  summary: string | null;
  content: string;
  url: string | null;
}

export async function runSemanticAlertMatch(
  env: SemanticAlertEnv,
  input: SemanticAlertMatchInput,
  deps?: SemanticAlertMatchDeps,
): Promise<void> {
  try {
    await matchAndDeliver(env, input, deps);
  } catch (err) {
    logEvent("warn", {
      component: "semantic-alerts",
      event: "semantic-alert-match-failed",
      sourceId: input.sourceId,
      errName: err instanceof Error ? err.name : "Error",
    });
  }
}

async function matchAndDeliver(
  env: SemanticAlertEnv,
  input: SemanticAlertMatchInput,
  deps: SemanticAlertMatchDeps | undefined,
): Promise<void> {
  if (input.releases.length === 0) return;
  const enabled = await flag(env.FLAGS, env.SEMANTIC_ALERTS_ENABLED, FLAGS.semanticAlertsEnabled);
  if (!enabled) return;
  if (!env.DB) return;
  if (!input.orgId && !input.productId) return;

  const db = createDb(env.DB as D1Database);
  const candidates = await listSemanticAlertCandidates(db, {
    orgId: input.orgId,
    productId: input.productId,
  });
  if (candidates.length === 0) return;

  const resolve = deps?.resolveModel ?? resolveSemanticAlertModel;
  const model = await resolve(env);
  if (!model) return;

  const bodies = await loadReleaseBodies(
    db,
    input.releases.map((release) => release.id),
  );
  const byAlert = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const scored: SemanticAlertCandidate[] = candidates.map((candidate) => ({
    id: candidate.id,
    query: candidate.query,
    threshold: candidate.threshold,
  }));

  for (const release of input.releases) {
    const body = bodies.get(release.id);
    if (!body) {
      logEvent("warn", {
        component: "semantic-alerts",
        event: "semantic-alert-release-missing",
        releaseId: release.id,
      });
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- one JEV call per release, chunked inside
    const claimedIds = await listClaimedSemanticAlertIds(
      db,
      release.id,
      scored.map((candidate) => candidate.id),
    );
    const pendingAlerts = scored.filter((candidate) => !claimedIds.has(candidate.id));
    if (pendingAlerts.length === 0) continue;
    // oxlint-disable-next-line no-await-in-loop -- one JEV call per release, chunked inside
    const outcome = await matchSemanticAlerts(
      model,
      buildSemanticAlertState({
        sourceName: input.sourceName,
        title: body.title,
        url: body.url,
        summary: body.summary,
        content: body.content,
      }),
      pendingAlerts,
      deps?.questionsPerCall ? { questionsPerCall: deps.questionsPerCall } : undefined,
    );
    for (const call of outcome.calls) {
      logEvent("info", {
        component: "ai",
        event: "ai_usage",
        provider: "openrouter",
        model: model.id,
        lane: "semantic-alert-match",
        environment: env.ENVIRONMENT,
        input: call.inputTokens,
        output: call.outputTokens,
        cacheCreate: 0,
        cacheRead: 0,
        promptTokens: call.inputTokens,
        cacheHitRate: 0,
        costUsd: call.costUsd,
        questionCount: call.questionCount,
        releaseId: release.id,
      });
    }
    for (const decision of outcome.decisions) {
      const alert = byAlert.get(decision.alertId);
      writeSemanticAlertPoint(env.RELEASE_CLASSIFICATIONS_AE, env.ENVIRONMENT, {
        releaseId: release.id,
        sourceId: input.sourceId,
        alertId: decision.alertId,
        provider: "openrouter",
        model: model.id,
        disposition: decision.disposition,
        failureCategory: decision.failureCategory,
        probability: decision.probability,
        threshold: alert?.threshold,
      });
    }
    // oxlint-disable-next-line no-await-in-loop -- delivery follows the decision for this release
    await deliverRelease(env, db, release.event, body, byAlert, outcome.decisions);
  }
}

async function loadReleaseBodies(db: AnyDb, ids: string[]): Promise<Map<string, ReleaseBody>> {
  const out = new Map<string, ReleaseBody>();
  for (const chunk of chunkArray(ids, IN_ARRAY_CHUNK_SIZE)) {
    if (chunk.length === 0) continue;
    // oxlint-disable-next-line no-await-in-loop -- D1 bind-budget chunks
    const rows = await db
      .select({
        id: releases.id,
        title: releases.title,
        summary: releases.summary,
        content: releases.content,
        url: releases.url,
      })
      .from(releases)
      .where(inArray(releases.id, chunk));
    for (const row of rows) out.set(row.id, row);
  }
  return out;
}

async function deliverRelease(
  env: SemanticAlertEnv,
  db: AnyDb,
  event: ReleaseEvent,
  body: ReleaseBody,
  alerts: Map<string, SemanticAlertCandidateRow>,
  decisions: SemanticAlertDecision[],
): Promise<void> {
  const claimed: Array<{ alert: SemanticAlertCandidateRow; probability: number }> = [];
  for (const decision of decisions) {
    if (!decision.matched || decision.probability === undefined) continue;
    const alert = alerts.get(decision.alertId);
    if (!alert) continue;
    // oxlint-disable-next-line no-await-in-loop -- claim is the idempotency lock
    const fresh = await claimSemanticAlertMatch(db, {
      alertId: alert.id,
      releaseId: body.id,
      probability: decision.probability,
    });
    if (fresh) claimed.push({ alert, probability: decision.probability });
  }
  if (claimed.length === 0) return;

  const userIds = [...new Set(claimed.map((item) => item.alert.userId))];
  const contacts = await loadContacts(db, userIds);
  const hooks = await loadWebhookTargets(
    db,
    claimed.map((item) => item.alert),
  );
  const manageUrl = `${releaseWebBase(env)}/account/notifications`;
  const releaseUrl = event.release.webUrl ?? body.url;
  const messages: DeliveryMessage[] = [];

  for (const item of claimed) {
    if (item.alert.deliverEmail) {
      const contact = contacts.get(item.alert.userId);
      if (!contact?.email) {
        logEvent("warn", {
          component: "semantic-alerts",
          event: "email-no-address",
          alertId: item.alert.id,
          releaseId: body.id,
        });
      } else {
        // oxlint-disable-next-line no-await-in-loop -- one account email per match
        await sendSemanticAlertEmail(env, {
          to: contact.email,
          recipientName: contact.name,
          query: item.alert.query,
          releaseTitle: body.title,
          sourceName: event.release.sourceName,
          summary: body.summary,
          releaseUrl,
          manageUrl,
          alertId: item.alert.id,
          releaseId: body.id,
        });
      }
    }
    if (item.alert.deliverWebhook) {
      const sub = hooks.get(item.alert.id);
      if (!sub) {
        logEvent("warn", {
          component: "semantic-alerts",
          event: "webhook-no-subscription",
          alertId: item.alert.id,
          releaseId: body.id,
        });
      } else {
        messages.push({
          subscriptionId: sub.id,
          url: sub.url,
          secretVersion: sub.secretVersion,
          format: sub.format,
          event,
          attempt: 1,
        });
      }
    }
  }

  await enqueueWebhookDeliveries(env, messages);
}

async function loadContacts(
  db: AnyDb,
  userIds: string[],
): Promise<Map<string, { email: string; name: string | null }>> {
  const out = new Map<string, { email: string; name: string | null }>();
  for (const chunk of chunkArray(userIds, IN_ARRAY_CHUNK_SIZE)) {
    // oxlint-disable-next-line no-await-in-loop -- D1 bind-budget chunks
    const rows = await db
      .select({
        id: user.id,
        email: user.email,
        displayEmail: user.displayEmail,
        name: user.name,
      })
      .from(user)
      .where(inArray(user.id, chunk));
    for (const row of rows) {
      out.set(row.id, {
        email: row.displayEmail || row.email,
        name: row.name || null,
      });
    }
  }
  return out;
}

interface WebhookTarget {
  id: string;
  url: string;
  secretVersion: number;
  format: "json" | "slack" | "discord";
}

async function loadWebhookTargets(
  db: AnyDb,
  alerts: SemanticAlertCandidateRow[],
): Promise<Map<string, WebhookTarget>> {
  const out = new Map<string, WebhookTarget>();
  const linkedIds = [
    ...new Set(
      alerts
        .filter((alert) => alert.deliverWebhook && alert.webhookSubscriptionId)
        .map((alert) => alert.webhookSubscriptionId as string),
    ),
  ];
  const followsUserIds = [
    ...new Set(
      alerts
        .filter((alert) => alert.deliverWebhook && !alert.webhookSubscriptionId)
        .map((alert) => alert.userId),
    ),
  ];

  const linked = new Map<string, WebhookTarget & { userId: string | null; enabled: boolean }>();
  for (const chunk of chunkArray(linkedIds, IN_ARRAY_CHUNK_SIZE)) {
    // oxlint-disable-next-line no-await-in-loop -- D1 bind-budget chunks
    const rows = await db
      .select({
        id: webhookSubscriptions.id,
        userId: webhookSubscriptions.userId,
        url: webhookSubscriptions.url,
        secretVersion: webhookSubscriptions.secretVersion,
        format: webhookSubscriptions.format,
        enabled: webhookSubscriptions.enabled,
      })
      .from(webhookSubscriptions)
      .where(inArray(webhookSubscriptions.id, chunk));
    for (const row of rows) linked.set(row.id, row);
  }

  const followsByUser = new Map<string, WebhookTarget>();
  if (followsUserIds.length > 0) {
    for (const chunk of chunkArray(followsUserIds, IN_ARRAY_CHUNK_SIZE)) {
      // oxlint-disable-next-line no-await-in-loop -- D1 bind-budget chunks
      const rows = await db
        .select({
          id: webhookSubscriptions.id,
          userId: webhookSubscriptions.userId,
          url: webhookSubscriptions.url,
          secretVersion: webhookSubscriptions.secretVersion,
          format: webhookSubscriptions.format,
        })
        .from(webhookSubscriptions)
        .where(
          and(
            eq(webhookSubscriptions.scope, "follows"),
            eq(webhookSubscriptions.enabled, true),
            inArray(webhookSubscriptions.userId, chunk),
          ),
        );
      for (const row of rows) {
        if (row.userId) followsByUser.set(row.userId, row);
      }
    }
  }

  for (const alert of alerts) {
    if (!alert.deliverWebhook) continue;
    if (alert.webhookSubscriptionId) {
      const sub = linked.get(alert.webhookSubscriptionId);
      if (sub && sub.enabled && sub.userId === alert.userId) {
        out.set(alert.id, sub);
      }
      continue;
    }
    const sub = followsByUser.get(alert.userId);
    if (sub) out.set(alert.id, sub);
  }
  return out;
}

async function enqueueWebhookDeliveries(
  env: SemanticAlertEnv,
  messages: DeliveryMessage[],
): Promise<void> {
  const queue = env.WEBHOOK_DELIVERY_QUEUE as
    | { sendBatch(messages: { body: DeliveryMessage }[]): Promise<unknown> }
    | undefined;
  if (!queue || messages.length === 0) return;
  try {
    for (let i = 0; i < messages.length; i += QUEUE_BATCH_LIMIT) {
      const chunk = messages.slice(i, i + QUEUE_BATCH_LIMIT);
      // oxlint-disable-next-line no-await-in-loop -- Cloudflare Queue chunked sendBatch
      await queue.sendBatch(chunk.map((body) => ({ body })));
    }
  } catch (err) {
    logEvent("warn", {
      component: "semantic-alerts",
      event: "webhook-enqueue-failed",
      count: messages.length,
      errName: err instanceof Error ? err.name : "Error",
    });
  }
}
