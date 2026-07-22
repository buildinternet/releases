/**
 * Gmail One-Click Action handlers
 * (https://developers.google.com/workspace/gmail/markup/reference/one-click-action).
 *
 * Gmail POSTs to these directly from the inbox list when the reader presses the
 * annotation button — no cookie, no session, no browser. The token in the query
 * string is the entire credential, exactly as it is in the emailed link, so the
 * security posture is unchanged from clicking that link: single-use, short-lived,
 * and opaque-404 on anything unknown so the endpoint can't be used to probe.
 *
 * Handlers must be idempotent (Google may retry) and must not redirect — Gmail
 * wants a 2xx and nothing else.
 *
 * The annotation only renders for senders Google has registered, so in practice
 * this route is reachable but unexercised until that registration lands. It
 * stays correct either way.
 */
import { Hono, type Context } from "hono";
import type { Env } from "../index.js";
import { createAuth } from "../auth/index.js";
import { respondError } from "../lib/error-response.js";
import { NotFoundError } from "@releases/lib/releases-error";
import { logEvent } from "@releases/lib/log-event";

export const emailActionRoutes = new Hono<Env>();

/**
 * One-click email verification. Replays the token through Better Auth's own
 * GET verify-email endpoint rather than reimplementing verification — one code
 * path owns token consumption, expiry, and the post-verification hooks.
 */
async function handleVerifyEmail(c: Context<Env>) {
  const token = c.req.query("token");
  if (!token) return respondError(c, new NotFoundError());

  const auth = await createAuth(c.env);
  const target = new URL("/api/auth/verify-email", new URL(c.req.url).origin);
  target.searchParams.set("token", token);

  const res = await auth.handler(new Request(target, { method: "GET" }));
  // Better Auth answers a good token with a redirect (302) or a 200 JSON body,
  // and a spent/expired/forged one with a 4xx. Anything short of an error is a
  // verification that happened.
  if (res.status >= 400) {
    logEvent("info", { component: "email-actions", event: "verify-rejected", status: res.status });
    return respondError(c, new NotFoundError());
  }
  logEvent("info", { component: "email-actions", event: "verify-ok" });
  return c.json({ success: true, verified: true });
}

emailActionRoutes.post("/email-actions/verify-email", handleVerifyEmail);
