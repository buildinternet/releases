/**
 * Operator notification + submitter acknowledgment for recommendation
 * submissions, plus the opt-in "your source was added" follow-up.
 * Submit/ack/notify are best-effort and must never fail the POST.
 * The added follow-up is operator-triggered only — never fired by
 * triage / close / archive.
 */
import { logEvent } from "@releases/lib/log-event";
import { releaseWebBase } from "@buildinternet/releases-core/release-slug";
import type { Recommendation } from "@buildinternet/releases-core/schema";
import { renderEmail } from "@releases/rendering/email-shell";
import { sendAuthEmail, type AuthEmailEnv } from "../../auth/email.js";
import { sendEmail, type EmailEnv } from "./email.js";

const DEFAULT_NOTIFY_MAX_PER_HOUR = 20;
const DEFAULT_ACK_MAX_PER_HOUR = 20;
const DEFAULT_ADDED_MAX_PER_HOUR = 20;
const HOUR_MS = 3_600_000;

type AtomicCounterStore = Pick<D1Database, "prepare">;

export type RecommendationNotifyEnv = EmailEnv & {
  DB?: AtomicCounterStore;
  RECOMMENDATION_NOTIFY_MAX_PER_HOUR?: string;
};

async function withinHourlyNotificationBudget(
  counter: AtomicCounterStore | undefined,
  keyPrefix: string,
  max: number,
): Promise<boolean> {
  if (!counter) return true;
  const bucket = Math.floor(Date.now() / HOUR_MS);
  const key = `${keyPrefix}:${bucket}`;
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

export async function withinRecommendationNotifyBudget(
  counter: AtomicCounterStore | undefined,
  max: number,
): Promise<boolean> {
  return withinHourlyNotificationBudget(counter, "recommendation:notify", max);
}

export async function withinRecommendationAckBudget(
  counter: AtomicCounterStore | undefined,
  max: number,
): Promise<boolean> {
  return withinHourlyNotificationBudget(counter, "recommendation:ack", max);
}

export async function withinRecommendationAddedBudget(
  counter: AtomicCounterStore | undefined,
  max: number,
): Promise<boolean> {
  return withinHourlyNotificationBudget(counter, "recommendation:added", max);
}

function truncate(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

const OPERATOR_FOOTER_REASON =
  "Internal notification from Releases — a visitor submitted a changelog URL for review.";

export function formatRecommendationEmail(row: Recommendation): {
  subject: string;
  text: string;
  html: string;
} {
  const subject = `[recommendation] ${row.type}: ${truncate(row.url, 72)}`;
  const { html, text } = renderEmail({
    lane: "Recommendation",
    title: "A visitor recommended a changelog source",
    blocks: [
      { t: "p", text: row.note ? row.note : "No additional note was left." },
      {
        t: "data",
        rows: [
          { label: "Type", value: row.type },
          { label: "URL", value: row.url },
          { label: "Contact", value: row.contactEmail ?? "(none)" },
          { label: "Surface", value: row.surface },
          { label: "Agent", value: row.userAgent ?? "(unknown)" },
          { label: "ID", value: row.id },
          { label: "When", value: new Date(row.createdAt).toISOString() },
        ],
      },
    ],
    footer: { reason: OPERATOR_FOOTER_REASON },
  });
  return { subject, text, html };
}

export type RecommendationAckEnv = AuthEmailEnv & {
  DB?: AtomicCounterStore;
  RECOMMENDATION_ACK_MAX_PER_HOUR?: string;
  RECOMMENDATION_ADDED_MAX_PER_HOUR?: string;
  WEB_BASE_URL?: string;
};

/** Live registry listing named in the opt-in "source added" email. */
export type RecommendationAddedListing = {
  orgName: string;
  orgSlug: string;
  sourceName?: string;
  sourceSlug?: string;
};

export type SendRecommendationAddedResult =
  | { sent: true; notifiedAt: number }
  | {
      sent: false;
      reason: "no_contact_email" | "already_notified" | "rate_capped" | "no_binding" | "error";
      notifiedAt?: number;
    };

/** Thank-you email sent to the submitter when they provide a contact address. */
export function formatRecommendationAckEmail(
  row: Recommendation,
  webOrigin: string,
): { subject: string; text: string; html: string } {
  const submitUrl = `${webOrigin}/submit`;
  // Name what they submitted in the subject: someone who suggested three sources
  // in a sitting gets three otherwise-identical acknowledgments.
  let host: string;
  try {
    host = new URL(row.url).hostname.replace(/^www\./, "");
  } catch {
    host = row.url;
  }
  const { html, text } = renderEmail({
    lane: "Account · Submission",
    title: "Thanks for the submission",
    preheader: `We received your suggestion for ${host}.`,
    blocks: [
      { t: "p", text: "Thanks for suggesting a changelog source for Releases Index." },
      {
        t: "p",
        text: "Our team reviews submissions and adds sources that fit the registry. We may reach out if we need more detail.",
      },
      { t: "fine", text: `Reference: ${row.id}` },
    ],
    footer: {
      reason:
        "You received this because you submitted a changelog URL at releases.sh/submit and provided this email address.",
      links: [{ label: "Submit another source", href: submitUrl }],
    },
  });
  return { subject: `We got your Releases Index submission — ${host}`, text, html };
}

function webOrigin(env: RecommendationAckEnv): string {
  const raw = releaseWebBase(env);
  try {
    return new URL(raw).origin;
  } catch {
    return "https://releases.sh";
  }
}

/** Send a submitter acknowledgment when they left a contact email. Never throws. */
export async function sendRecommendationAck(
  env: RecommendationAckEnv,
  row: Recommendation,
): Promise<void> {
  if (!row.contactEmail) return;
  try {
    const max = parseInt(env.RECOMMENDATION_ACK_MAX_PER_HOUR ?? "", 10) || DEFAULT_ACK_MAX_PER_HOUR;
    if (!(await withinRecommendationAckBudget(env.DB, max))) {
      logEvent("warn", {
        component: "recommendations",
        event: "ack-rate-capped",
        id: row.id,
        maxPerHour: max,
      });
      return;
    }

    const rendered = formatRecommendationAckEmail(row, webOrigin(env));
    const result = await sendAuthEmail(env, {
      to: row.contactEmail,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    });
    if (!result.sent) {
      logEvent("info", {
        component: "recommendations",
        event: "ack-skipped",
        reason: result.reason,
        id: row.id,
      });
    } else {
      logEvent("info", { component: "recommendations", event: "ack-sent", id: row.id });
    }
  } catch (err) {
    logEvent("warn", { component: "recommendations", event: "ack-error", id: row.id, err });
  }
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

    const { subject, text, html } = formatRecommendationEmail(row);
    const result = await sendEmail(env, { subject, text, html });
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

export function recommendationRegistryUrl(
  origin: string,
  listing: RecommendationAddedListing,
): string {
  return listing.sourceSlug
    ? `${origin}/${listing.orgSlug}/${listing.sourceSlug}`
    : `${origin}/${listing.orgSlug}`;
}

function listingLabel(listing: RecommendationAddedListing): string {
  return listing.sourceName ? `${listing.orgName} — ${listing.sourceName}` : listing.orgName;
}

/** Opt-in follow-up: the submitter's suggestion is now on the registry. */
export function formatRecommendationAddedEmail(
  row: Recommendation,
  listing: RecommendationAddedListing,
  origin: string,
): { subject: string; text: string; html: string } {
  const registryUrl = recommendationRegistryUrl(origin, listing);
  const name = listingLabel(listing);
  const buttonLabel = listing.sourceSlug ? "View source" : "View organization";
  const what =
    listing.sourceName != null
      ? `**${listing.sourceName}** from **${listing.orgName}**`
      : `**${listing.orgName}**`;
  const { html, text } = renderEmail({
    lane: "Account · Submission",
    title: "Your submission was added",
    preheader: `${name} is now listed on Releases Index.`,
    blocks: [
      {
        t: "p",
        text: `The changelog source you suggested is now listed on Releases Index as ${what}.`,
      },
      { t: "button", label: buttonLabel, url: registryUrl },
      { t: "fine", text: `Reference: ${row.id}` },
    ],
    footer: {
      reason:
        "You received this because you submitted a changelog URL at releases.sh/submit and provided this email address.",
      links: [{ label: buttonLabel, href: registryUrl }],
    },
    action: { kind: "view", name: buttonLabel, url: registryUrl },
  });
  return { subject: `Your submission is on Releases Index — ${name}`, text, html };
}

/**
 * Send the opt-in "source added" email. Does not stamp `addedNotifiedAt` —
 * the caller writes that after a successful send. Never throws.
 */
export async function sendRecommendationAdded(
  env: RecommendationAckEnv,
  row: Recommendation,
  listing: RecommendationAddedListing,
): Promise<SendRecommendationAddedResult> {
  if (!row.contactEmail) {
    logEvent("info", {
      component: "recommendations",
      event: "added-skipped",
      reason: "no_contact_email",
      id: row.id,
    });
    return { sent: false, reason: "no_contact_email" };
  }
  if (row.addedNotifiedAt != null) {
    logEvent("info", {
      component: "recommendations",
      event: "added-skipped",
      reason: "already_notified",
      id: row.id,
      notifiedAt: row.addedNotifiedAt,
    });
    return { sent: false, reason: "already_notified", notifiedAt: row.addedNotifiedAt };
  }

  try {
    const max =
      parseInt(
        env.RECOMMENDATION_ADDED_MAX_PER_HOUR ?? env.RECOMMENDATION_ACK_MAX_PER_HOUR ?? "",
        10,
      ) || DEFAULT_ADDED_MAX_PER_HOUR;
    if (!(await withinRecommendationAddedBudget(env.DB, max))) {
      logEvent("warn", {
        component: "recommendations",
        event: "added-rate-capped",
        id: row.id,
        maxPerHour: max,
      });
      return { sent: false, reason: "rate_capped" };
    }

    const rendered = formatRecommendationAddedEmail(row, listing, webOrigin(env));
    const result = await sendAuthEmail(env, {
      to: row.contactEmail,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    });
    if (!result.sent) {
      logEvent("info", {
        component: "recommendations",
        event: "added-skipped",
        reason: result.reason,
        id: row.id,
      });
      return { sent: false, reason: result.reason === "no_binding" ? "no_binding" : "error" };
    }
    logEvent("info", { component: "recommendations", event: "added-sent", id: row.id });
    return { sent: true, notifiedAt: Date.now() };
  } catch (err) {
    logEvent("warn", { component: "recommendations", event: "added-error", id: row.id, err });
    return { sent: false, reason: "error" };
  }
}
