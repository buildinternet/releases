/**
 * Pure formatter + thin sender for recommendation-arrival emails.
 * Like feedback notifications, this is best-effort and must never fail the
 * recommendation path.
 */
import { logEvent } from "@releases/lib/log-event";
import type { Recommendation } from "@buildinternet/releases-core/schema";
import { sendEmail, type EmailEnv } from "./email.js";

const DEFAULT_NOTIFY_MAX_PER_HOUR = 20;
const HOUR_MS = 3_600_000;

type AtomicCounterStore = Pick<D1Database, "prepare">;

export type RecommendationNotifyEnv = EmailEnv & {
  DB?: AtomicCounterStore;
  RECOMMENDATION_NOTIFY_MAX_PER_HOUR?: string;
};

export async function withinRecommendationNotifyBudget(
  counter: AtomicCounterStore | undefined,
  max: number,
): Promise<boolean> {
  if (!counter) return true;
  const bucket = Math.floor(Date.now() / HOUR_MS);
  const key = `recommendation:notify:${bucket}`;
  const expiresAt = (bucket + 2) * HOUR_MS;
  await counter
    .prepare("DELETE FROM notification_counters WHERE expires_at < ?")
    .bind(Date.now())
    .run();
  const row = await counter
    .prepare(
      `INSERT INTO notification_counters (key, count, expires_at)
       VALUES (?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET
         count = count + 1,
         expires_at = excluded.expires_at
       RETURNING count`,
    )
    .bind(key, expiresAt)
    .first<{ count: number }>();
  return Number(row?.count ?? max + 1) <= max;
}

function truncate(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

export function formatRecommendationEmail(row: Recommendation): {
  subject: string;
  text: string;
} {
  const subject = `[recommendation] ${row.type}: ${truncate(row.url, 72)}`;
  const text = [
    "A recommendation was submitted from the web app.",
    "",
    `Type: ${row.type}`,
    `URL: ${row.url}`,
    `Additional info: ${row.note ?? "(none)"}`,
    `Email to notify: ${row.contactEmail ?? "(none)"}`,
    "",
    "—",
    `ID: ${row.id}`,
    `Surface: ${row.surface}`,
    `User agent: ${row.userAgent ?? "(unknown)"}`,
    `Received: ${new Date(row.createdAt).toISOString()}`,
  ].join("\n");
  return { subject, text };
}

export async function notifyRecommendation(
  env: RecommendationNotifyEnv,
  row: Recommendation,
): Promise<void> {
  try {
    const max =
      parseInt(env.RECOMMENDATION_NOTIFY_MAX_PER_HOUR ?? "", 10) || DEFAULT_NOTIFY_MAX_PER_HOUR;
    if (!(await withinRecommendationNotifyBudget(env.DB, max))) {
      logEvent("warn", {
        component: "recommendations",
        event: "notify-rate-capped",
        id: row.id,
        maxPerHour: max,
      });
      return;
    }

    const { subject, text } = formatRecommendationEmail(row);
    const result = await sendEmail(env, { subject, text });
    if (!result.sent) {
      logEvent("info", {
        component: "recommendations",
        event: "notify-skipped",
        reason: result.reason,
        id: row.id,
      });
    } else {
      logEvent("info", { component: "recommendations", event: "notify-sent", id: row.id });
    }
  } catch (err) {
    logEvent("warn", { component: "recommendations", event: "notify-error", id: row.id, err });
  }
}
