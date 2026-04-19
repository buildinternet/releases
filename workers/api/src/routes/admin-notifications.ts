/**
 * Ad-hoc send path for exercising the email notification pipeline without
 * waiting for a cron to fire. Auth-gated via the `admin/notifications` entry
 * in workers/api/src/index.ts.
 */
import { Hono } from "hono";
import { sendCronReport } from "../lib/notifications.js";
import { sendEmail } from "../lib/email.js";
import type { CronReport, CronReportStatus } from "../lib/cron-report.js";
import type { Env } from "../index.js";

export const adminNotificationsRoutes = new Hono<Env>();

type TestBody = {
  /** Override recipient; defaults to EMAIL_NOTIFY_TO. */
  to?: string;
  /** Fabricated status for the sample cron report. */
  status?: CronReportStatus;
  /** Cron name to impersonate in the report. */
  cronName?: string;
  /** If true, skip the cron-report wrapper and send a bare test email. */
  plain?: boolean;
  /** Subject override when `plain: true`. */
  subject?: string;
  /** Body override when `plain: true`. */
  body?: string;
};

const VALID_STATUSES: CronReportStatus[] = ["done", "degraded", "dispatch_failed", "aborted"];

adminNotificationsRoutes.post("/admin/notifications/test", async (c) => {
  const body = await c.req.json<TestBody>().catch(() => ({}) as TestBody);

  if (body.plain) {
    const result = await sendEmail(c.env, {
      subject: body.subject ?? "[test] releases notifications",
      text:
        body.body ??
        "Test email from the releases API. If you got this, the send_email binding is wired correctly.",
      to: body.to,
    });
    return c.json({ ok: result.sent, result }, result.sent ? 200 : 202);
  }

  const status: CronReportStatus =
    body.status && VALID_STATUSES.includes(body.status) ? body.status : "done";
  const now = new Date();
  const startedAt = new Date(now.getTime() - 7500).toISOString();
  const endedAt = now.toISOString();

  const fabricated: CronReport = {
    cronName: body.cronName ?? "scrape-agent-sweep",
    runId: `crun_test_${now.getTime()}`,
    status,
    startedAt,
    endedAt,
    durationMs: 7500,
    candidates: status === "done" ? 3 : 4,
    dispatched: status === "dispatch_failed" ? 0 : status === "degraded" ? 2 : 3,
    skippedOverCap: 0,
    dispatchErrors: status === "done" ? 0 : status === "degraded" ? 1 : 4,
    abortReason: status === "aborted" ? "anthropic_credits" : undefined,
    notes: `Ad-hoc test email triggered via /v1/admin/notifications/test`,
    sessionsStarted: status === "done" || status === "degraded" ? ["ma_test_1", "ma_test_2"] : [],
    dispatchErrorDetail:
      status === "degraded"
        ? [{ orgSlug: "example-org", error: "502 Bad Gateway (fabricated)" }]
        : status === "dispatch_failed"
          ? [
              { orgSlug: "example-org-a", error: "timeout (fabricated)" },
              { orgSlug: "example-org-b", error: "502 Bad Gateway (fabricated)" },
            ]
          : [],
    adminBaseUrl: c.env.ADMIN_BASE_URL,
  };

  const result = await sendCronReport(c.env, fabricated, body.to ? { to: body.to } : undefined);
  return c.json(
    {
      ok: "sent" in result && result.sent,
      result,
      report: fabricated,
    },
    "sent" in result && result.sent ? 200 : 202,
  );
});
