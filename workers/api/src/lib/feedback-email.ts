/**
 * Pure formatter + thin sender for the feedback-arrival notification.
 * `notifyFeedback` is fire-and-forget (never throws) so a mail failure can't
 * fail the submit — callers invoke it via `c.executionCtx.waitUntil(...)`.
 */
import { sendEmail, type EmailEnv } from "./email.js";
import { logEvent } from "@releases/lib/log-event";
import type { Feedback } from "@buildinternet/releases-core/schema";

function truncate(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

export function formatFeedbackEmail(row: Feedback): { subject: string; text: string } {
  const subject = `[feedback] ${row.type}: ${truncate(row.message, 60)}`;
  const text = [
    row.message,
    "",
    "—",
    `Contact: ${row.contact ?? "(none)"}`,
    `Type: ${row.type}`,
    `ID: ${row.id}`,
    `CLI: ${row.cliVersion ?? "(unknown)"}`,
    `Client: ${row.clientKind}`,
    `Env: ${row.os ?? "?"}/${row.arch ?? "?"} ${row.runtime ?? "?"}`,
    `Anon: ${row.anonId ?? "(omitted)"}`,
    `Received: ${new Date(row.createdAt).toISOString()}`,
  ].join("\n");
  return { subject, text };
}

export async function notifyFeedback(env: EmailEnv, row: Feedback): Promise<void> {
  const { subject, text } = formatFeedbackEmail(row);
  try {
    const result = await sendEmail(env, { subject, text });
    if (!result.sent) {
      logEvent("info", {
        component: "feedback",
        event: "notify-skipped",
        reason: result.reason,
        id: row.id,
      });
    } else {
      logEvent("info", { component: "feedback", event: "notify-sent", id: row.id });
    }
  } catch (err) {
    logEvent("warn", { component: "feedback", event: "notify-error", id: row.id, err });
  }
}
