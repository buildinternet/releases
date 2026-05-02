/**
 * Always sends so the operator knows the cron ran. Subject is prefixed with a
 * severity marker so inbox filters can surface failures without parsing the
 * body. Non-throwing: email send failures are logged and never fail the cron.
 */
import { sendEmail, type EmailEnv, type SendEmailResult } from "./email.js";
import { formatCronReport, type CronReport } from "./cron-report.js";
import { logEvent } from "@releases/lib/log-event";

export async function sendCronReport(
  env: EmailEnv,
  report: CronReport,
  opts?: { to?: string },
): Promise<SendEmailResult | { sent: false; reason: "error"; error: string }> {
  const formatted = formatCronReport(report);
  try {
    const result = await sendEmail(env, {
      subject: formatted.subject,
      text: formatted.text,
      html: formatted.html,
      to: opts?.to,
    });
    if (!result.sent) {
      logEvent("info", {
        component: "notifications",
        event: "report-skipped",
        cronName: report.cronName,
        reason: result.reason,
      });
    }
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logEvent("warn", {
      component: "notifications",
      event: "report-send-failed",
      cronName: report.cronName,
      err: message,
    });
    return { sent: false, reason: "error", error: message };
  }
}
