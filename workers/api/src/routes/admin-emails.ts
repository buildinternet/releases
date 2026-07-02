/**
 * Admin email test-send: fabricate and deliver a sample of every outbound
 * template to a chosen inbox (typically the signed-in admin's address).
 */
import { Hono } from "hono";
import { logEvent } from "@releases/lib/log-event";
import { EMAIL_SAMPLE_CATALOG, isEmailSampleId, sendEmailSample } from "../lib/email-samples.js";
import type { Env } from "../index.js";
import { respondError } from "../lib/error-response.js";
import { ValidationError } from "@releases/lib/releases-error";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const adminEmailsRoutes = new Hono<Env>();

adminEmailsRoutes.get("/admin/emails/samples", (c) => {
  return c.json({ samples: EMAIL_SAMPLE_CATALOG });
});

interface TestBody {
  type?: unknown;
  to?: unknown;
}

adminEmailsRoutes.post("/admin/emails/test", async (c) => {
  const body = await c.req.json<TestBody>().catch(() => ({}) as TestBody);
  const type = typeof body.type === "string" ? body.type : "";
  if (!isEmailSampleId(type)) {
    return respondError(
      c,
      new ValidationError("type must be a known email sample id", {
        code: "bad_request",
        details: { samples: EMAIL_SAMPLE_CATALOG.map((s) => s.id) },
      }),
    );
  }

  const to = typeof body.to === "string" && body.to.trim() ? body.to.trim() : c.env.EMAIL_NOTIFY_TO;
  if (!to || !EMAIL_PATTERN.test(to)) {
    return respondError(
      c,
      new ValidationError("Provide a valid to address in the request body.", {
        code: "bad_request",
      }),
    );
  }

  const result = await sendEmailSample(c.env, type, to);

  logEvent("info", {
    component: "admin-emails",
    event: result.sent ? "test-sent" : "test-skipped",
    type,
    channel: result.channel,
    to,
    ...(result.sent ? {} : { reason: result.reason }),
    environment: c.env.ENVIRONMENT,
  });

  return c.json(
    {
      ok: result.sent,
      type,
      to,
      channel: result.channel,
      ...(result.sent ? {} : { reason: result.reason }),
    },
    result.sent ? 200 : 202,
  );
});
