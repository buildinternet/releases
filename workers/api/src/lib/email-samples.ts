/**
 * Fabricated samples for every outbound email lane. Used by the admin test-send
 * route so operators can preview delivery without triggering real auth flows.
 */
import type { ReleaseLatestItem } from "@buildinternet/releases-api-types";
import { releaseWebBase } from "@buildinternet/releases-core/release-slug";
import type { Feedback, Recommendation } from "@buildinternet/releases-core/schema";
import {
  changeEmailTemplate,
  magicLinkTemplate,
  resetPasswordTemplate,
  sendAuthEmail,
  verifyEmailTemplate,
  type AuthEmailEnv,
} from "../auth/email.js";
import { buildDigestEmail } from "./digest-email.js";
import { formatFeedbackEmail } from "./feedback-email.js";
import { formatPollFetchAlert } from "./poll-fetch-alert.js";
import { formatRecommendationAckEmail, formatRecommendationEmail } from "./recommendation-email.js";
import { buildNoResultsAlert } from "./search-no-results.js";
import { formatCronCrashAlert } from "./send-alert.js";
import {
  formatAutoDisableAlert,
  formatDlqAlert,
  type SubscriptionLabel,
} from "@releases/core-internal/webhook-alert-format";
import { buildStalenessDigestEmail } from "./staleness-digest-email.js";
import { formatCronReport, type CronReport } from "./cron-report.js";
import { sendEmail, type EmailEnv } from "./email.js";

export const EMAIL_SAMPLE_CHANNELS = ["auth", "operator"] as const;
export type EmailSampleChannel = (typeof EMAIL_SAMPLE_CHANNELS)[number];

export type EmailSampleId =
  | "auth.verify"
  | "auth.reset-password"
  | "auth.change-email"
  | "auth.magic-link"
  | "digest.daily"
  | "digest.weekly"
  | "recommendation.ack"
  | "operator.recommendation"
  | "operator.feedback"
  | "operator.cron-report"
  | "operator.staleness-digest"
  | "operator.alert.cron-crash"
  | "operator.alert.poll-fetch"
  | "operator.alert.search-no-results"
  | "operator.alert.webhook-dlq"
  | "operator.alert.webhook-auto-disable";

export type EmailSampleMeta = {
  id: EmailSampleId;
  label: string;
  description: string;
  channel: EmailSampleChannel;
};

export const EMAIL_SAMPLE_CATALOG: EmailSampleMeta[] = [
  {
    id: "auth.verify",
    label: "Verify email",
    description: "Sign-up / unverified sign-in verification link",
    channel: "auth",
  },
  {
    id: "auth.reset-password",
    label: "Reset password",
    description: "Forgot-password reset link",
    channel: "auth",
  },
  {
    id: "auth.change-email",
    label: "Confirm email change",
    description: "Confirmation sent to the current address",
    channel: "auth",
  },
  {
    id: "auth.magic-link",
    label: "Magic link sign-in",
    description: "Passwordless one-time sign-in link",
    channel: "auth",
  },
  {
    id: "digest.daily",
    label: "Follow digest (daily)",
    description: "Opt-in digest of followed releases",
    channel: "auth",
  },
  {
    id: "digest.weekly",
    label: "Follow digest (weekly)",
    description: "Weekly variant of the follow digest",
    channel: "auth",
  },
  {
    id: "recommendation.ack",
    label: "Submission thank-you",
    description: "Acknowledgment after /submit with a contact email",
    channel: "auth",
  },
  {
    id: "operator.recommendation",
    label: "New recommendation (admin)",
    description: "Internal alert when someone submits a changelog URL",
    channel: "operator",
  },
  {
    id: "operator.feedback",
    label: "CLI feedback (admin)",
    description: "Internal alert from releases feedback",
    channel: "operator",
  },
  {
    id: "operator.cron-report",
    label: "Cron run report",
    description: "Scrape-agent sweep summary after each cron run",
    channel: "operator",
  },
  {
    id: "operator.staleness-digest",
    label: "Staleness digest",
    description: "Daily rollup of overdue first-party + Firecrawl sources",
    channel: "operator",
  },
  {
    id: "operator.alert.cron-crash",
    label: "Alert: cron crash",
    description: "Tier-1 alert when a scheduled cron throws",
    channel: "operator",
  },
  {
    id: "operator.alert.poll-fetch",
    label: "Alert: poll-and-fetch failure",
    description: "Tier-1 alert when sources fail during poll-and-fetch",
    channel: "operator",
  },
  {
    id: "operator.alert.search-no-results",
    label: "Alert: search no-results spike",
    description: "Tier-1 alert when zero-hit search rate exceeds threshold",
    channel: "operator",
  },
  {
    id: "operator.alert.webhook-dlq",
    label: "Alert: webhook DLQ",
    description: "Webhook worker DLQ batch notification",
    channel: "operator",
  },
  {
    id: "operator.alert.webhook-auto-disable",
    label: "Alert: webhook auto-disable",
    description: "Webhook subscription disabled after consecutive failures",
    channel: "operator",
  },
];

const SAMPLE_IDS = new Set(EMAIL_SAMPLE_CATALOG.map((s) => s.id));

export function isEmailSampleId(id: string): id is EmailSampleId {
  return SAMPLE_IDS.has(id as EmailSampleId);
}

export type EmailSampleEnv = AuthEmailEnv &
  EmailEnv & {
    WEB_BASE_URL?: string;
    API_BASE_URL?: string;
    ADMIN_BASE_URL?: string;
  };

function webOrigin(env: EmailSampleEnv): string {
  const raw = releaseWebBase(env);
  try {
    return new URL(raw).origin;
  } catch {
    return "https://releases.sh";
  }
}

function apiOrigin(env: EmailSampleEnv): string {
  const raw = env.API_BASE_URL ?? "https://api.releases.sh";
  try {
    return new URL(raw).origin;
  } catch {
    return "https://api.releases.sh";
  }
}

const TEST_TOKEN = "test-token-sample-only";

function sampleDigestRelease(): ReleaseLatestItem {
  return {
    id: "rel_sample_1",
    version: null,
    type: "feature",
    title: "Sample release for email preview",
    summary: "This is fabricated content for an admin test send.",
    titleGenerated: null,
    titleShort: "Sample release",
    publishedAt: new Date().toISOString(),
    url: "https://releases.sh/release/rel_sample_1",
    media: [],
    source: {
      slug: "changelog",
      name: "Example Changelog",
      type: "scrape",
      orgSlug: "example",
      orgName: "Example Co",
    },
    product: { slug: "platform", name: "Platform" },
    coverageCount: 0,
    contentChars: null,
    contentTokens: null,
  } as ReleaseLatestItem;
}

const SAMPLE_RECOMMENDATION: Recommendation = {
  id: "rec_sample_1",
  createdAt: Date.now(),
  type: "source",
  url: "https://example.com/changelog",
  note: "Sample submission note for email preview.",
  contactEmail: "you@example.com",
  status: "new",
  archived: false,
  surface: "web",
  userAgent: "Releases admin email test",
};

const SAMPLE_SUBSCRIPTION: SubscriptionLabel = {
  id: "whk_sample",
  url: "https://example.com/webhooks/releases",
  description: "Sample webhook",
  orgName: "Example Co",
  orgSlug: "example",
};

const SAMPLE_FEEDBACK: Feedback = {
  id: "fb_sample_1",
  createdAt: Date.now(),
  type: "idea",
  message: "Sample CLI feedback for email preview.",
  contact: "you@example.com",
  status: "new",
  archived: false,
  surface: "cli",
  cliVersion: "0.2.0",
  clientKind: "cli",
  os: "darwin",
  arch: "arm64",
  runtime: "bun",
  anonId: null,
};

function sampleCronReport(env: EmailSampleEnv): CronReport {
  const now = new Date();
  const startedAt = new Date(now.getTime() - 7500).toISOString();
  return {
    cronName: "scrape-agent-sweep",
    runId: "crun_sample_1",
    status: "degraded",
    startedAt,
    endedAt: now.toISOString(),
    durationMs: 7500,
    candidates: 4,
    dispatched: 2,
    skippedOverCap: 0,
    dispatchErrors: 1,
    notes: "Sample cron report for admin email test.",
    sessionsStarted: ["ma_sample_1"],
    dispatchErrorDetail: [{ orgSlug: "example", error: "502 Bad Gateway (sample)" }],
    results: {
      perOrg: [
        {
          orgSlug: "example",
          orgName: "Example Co",
          sourcesFetched: 2,
          releasesFound: 5,
          releasesInserted: 1,
          errors: 0,
        },
      ],
      sessionsWithNoActivity: 0,
      settleWindowMinutes: 15,
    },
    adminBaseUrl: env.ADMIN_BASE_URL,
  };
}

export type RenderedEmail = { subject: string; text: string; html?: string };

export function renderEmailSample(env: EmailSampleEnv, id: EmailSampleId): RenderedEmail {
  const web = webOrigin(env);
  const api = apiOrigin(env);

  switch (id) {
    case "auth.verify":
      return verifyEmailTemplate({
        url: `${api}/api/auth/verify-email?token=${TEST_TOKEN}`,
        webOrigin: web,
      });
    case "auth.reset-password":
      return resetPasswordTemplate({
        url: `${api}/api/auth/reset-password/${TEST_TOKEN}?callbackURL=${encodeURIComponent(web)}`,
        webOrigin: web,
      });
    case "auth.change-email":
      return changeEmailTemplate({
        url: `${api}/api/auth/verify-email?token=${TEST_TOKEN}`,
        newEmail: "new-address@example.com",
        webOrigin: web,
      });
    case "auth.magic-link":
      return magicLinkTemplate({
        url: `${api}/api/auth/magic-link/verify?token=${TEST_TOKEN}`,
        webOrigin: web,
      });
    case "digest.daily":
    case "digest.weekly": {
      const cadence = id === "digest.weekly" ? "weekly" : "daily";
      return buildDigestEmail({
        recipientName: "Admin",
        cadence,
        releases: [sampleDigestRelease()],
        baseUrl: web,
        manageUrl: `${web}/following`,
        unsubscribeUrl: `${api}/v1/digest/unsubscribe/reld_sample`,
        referenceDate: new Date().toISOString(),
      });
    }
    case "recommendation.ack":
      return formatRecommendationAckEmail(SAMPLE_RECOMMENDATION, web);
    case "operator.recommendation":
      return formatRecommendationEmail(SAMPLE_RECOMMENDATION);
    case "operator.feedback":
      return formatFeedbackEmail(SAMPLE_FEEDBACK);
    case "operator.cron-report":
      return formatCronReport(sampleCronReport(env));
    case "operator.staleness-digest":
      return buildStalenessDigestEmail({
        scannedAt: new Date().toISOString(),
        webOrigin: web,
        firstParty: [
          {
            sourceId: "src_sample_1",
            slug: "changelog",
            orgSlug: "example",
            orgName: "Example Co",
            sourceType: "scrape",
            medianGapDays: 7,
            windowDays: 21,
            daysSinceNewest: 30,
            newestRelease: "2026-05-01T00:00:00.000Z",
            lastSeenAt: new Date().toISOString(),
          },
        ],
        firecrawl: [
          {
            sourceId: "src_sample_fc",
            slug: "docs",
            orgSlug: "example",
            orgName: "Example Co",
            lastFetchedAt: "2026-06-10T00:00:00.000Z",
            staleHours: 48,
            thresholdBasis: "floor",
          },
        ],
      });
    case "operator.alert.cron-crash": {
      const alert = formatCronCrashAlert({
        tag: "sample-cron",
        message: "Sample error for admin email preview",
        firedAt: new Date().toISOString(),
      });
      return { subject: alert.subject, text: alert.body, html: alert.html };
    }
    case "operator.alert.poll-fetch": {
      const alert = formatPollFetchAlert(
        [{ sourceId: "src_sample", stepName: "fetch", error: "Timed out after 5m (sample)" }],
        new Map([
          [
            "src_sample",
            {
              sourceId: "src_sample",
              sourceName: "Changelog",
              sourceSlug: "changelog",
              sourceUrl: "https://example.com/changelog",
              sourceType: "scrape",
              orgName: "Example Co",
              orgSlug: "example",
            },
          ],
        ]),
        Date.now(),
      );
      return alert;
    }
    case "operator.alert.search-no-results":
      return buildNoResultsAlert(
        {
          total: 120,
          zeroHits: 29,
          topQueries: [
            { query: "sample zero hit", count: 8, lastSeen: Date.now() },
            { query: "another miss", count: 5, lastSeen: Date.now() },
          ],
        },
        { fire: true, ratio: 0.24 },
        { thresholdPct: 20, minVolume: 50 },
      );
    // Rendered by the REAL formatters (shared via core-internal) rather than
    // rebuilt here: a hand-copied preview drifts from what operators actually
    // receive, which defeats the point of having a preview at all.
    case "operator.alert.webhook-dlq": {
      const alert = formatDlqAlert([
        {
          subId: "whk_sample",
          count: 3,
          lastError: "Connection refused (sample)",
          label: SAMPLE_SUBSCRIPTION,
        },
      ]);
      return { subject: alert.subject, text: alert.body, html: alert.html };
    }
    case "operator.alert.webhook-auto-disable": {
      const alert = formatAutoDisableAlert({
        subId: SAMPLE_SUBSCRIPTION.id,
        url: SAMPLE_SUBSCRIPTION.url,
        description: SAMPLE_SUBSCRIPTION.description,
        orgName: SAMPLE_SUBSCRIPTION.orgName,
        orgSlug: SAMPLE_SUBSCRIPTION.orgSlug,
        consecutiveFailures: 50,
        lastError: "HTTP 500 (sample)",
      });
      return { subject: alert.subject, text: alert.body, html: alert.html };
    }
    default: {
      const _exhaustive: never = id;
      throw new Error(`Unhandled sample id: ${_exhaustive}`);
    }
  }
}

export type SendEmailSampleResult =
  | { sent: true; channel: EmailSampleChannel }
  | { sent: false; channel: EmailSampleChannel; reason: string };

export async function sendEmailSample(
  env: EmailSampleEnv,
  id: EmailSampleId,
  to: string,
): Promise<SendEmailSampleResult> {
  const meta = EMAIL_SAMPLE_CATALOG.find((s) => s.id === id);
  if (!meta) return { sent: false, channel: "operator", reason: "unknown_sample" };

  const rendered = renderEmailSample(env, id);
  const subject = `[test] ${rendered.subject}`;

  if (meta.channel === "auth") {
    if (!env.AUTH_EMAIL) return { sent: false, channel: "auth", reason: "no_auth_binding" };
    const result = await sendAuthEmail(env, {
      to,
      subject,
      text: rendered.text,
      html: rendered.html ?? `<pre>${rendered.text}</pre>`,
    });
    if (!result.sent) {
      return { sent: false, channel: "auth", reason: result.reason };
    }
    return { sent: true, channel: "auth" };
  }

  const result = await sendEmail(env, { subject, text: rendered.text, html: rendered.html, to });
  if (!result.sent) {
    return { sent: false, channel: "operator", reason: result.reason };
  }
  return { sent: true, channel: "operator" };
}
