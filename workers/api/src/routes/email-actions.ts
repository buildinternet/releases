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
 * Rate limiting is done HERE, in the handler, not by route middleware:
 * `publicRateLimitMiddleware` short-circuits on non-safe methods, so mounting it
 * over this namespace would throttle nothing and read as protection that isn't
 * there. These handlers reuse `AUTH_RATE_LIMITER` — the same per-IP edge limiter
 * that fronts `POST /api/auth/*`, since this is the same threat (guessing at a
 * single-use auth token) and it's already provisioned.
 *
 * The annotation only renders for senders Google has registered, so in practice
 * this route is reachable but unexercised until that registration lands. It
 * stays correct either way.
 */
import { Hono, type Context } from "hono";
import type { Env } from "../index.js";
import { createAuth } from "../auth/index.js";
import { respondError } from "../lib/error-response.js";
import { NotFoundError, RateLimitedError } from "@releases/lib/releases-error";
import { logEvent } from "@releases/lib/log-event";
import { edgeRateLimitIpKey, selectAuthEdgeLimiter } from "../middleware/rate-limit.js";

export const emailActionRoutes = new Hono<Env>();

/**
 * One-click email verification. Replays the token through Better Auth's own
 * GET verify-email endpoint rather than reimplementing verification — one code
 * path owns token consumption, expiry, and the post-verification hooks.
 */
async function handleVerifyEmail(c: Context<Env>) {
  const limiter = selectAuthEdgeLimiter(
    c.req.method,
    c.env.AUTH_EDGE_RATE_LIMIT_ENABLED,
    c.env.AUTH_RATE_LIMITER,
  );
  if (limiter) {
    // Key by /64 for IPv6 so one subnet can't rotate addresses past the cap.
    const ip = c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for") ?? "unknown";
    const { success } = await limiter.limit({ key: edgeRateLimitIpKey(ip) });
    if (!success) {
      return respondError(c, new RateLimitedError("Too many requests. Please try again later."));
    }
  }

  // A tokenless request is a malformed call, not a failed verification — the
  // only case that isn't answered 2xx.
  const token = c.req.query("token");
  if (!token) return respondError(c, new NotFoundError());

  const auth = await createAuth(c.env);
  const target = new URL("/api/auth/verify-email", new URL(c.req.url).origin);
  target.searchParams.set("token", token);

  const res = await auth.handler(new Request(target, { method: "GET" }));

  // Every outcome answers 2xx, and the reason why is worth spelling out.
  //
  // A verify token is single-use: once spent it's gone, so a Gmail RETRY of an
  // action that already succeeded is indistinguishable from a forged token —
  // both reach Better Auth as "unknown". Returning an error would therefore
  // report failure for a verification that happened, which is exactly the
  // idempotency Google's one-click contract requires us not to break.
  //
  // Answering uniformly also removes the oracle: a caller guessing at tokens
  // learns nothing from the response, whereas a 404-on-bad / 200-on-good split
  // would confirm hits. The real outcome goes to the logs, which is where an
  // operator would look anyway — the reader never sees this response, only
  // Gmail does.
  const status = res.status;
  logEvent("info", {
    component: "email-actions",
    event: status < 400 ? "verify-ok" : "verify-noop",
    status,
  });
  return c.json({ success: true });
}

emailActionRoutes.post("/email-actions/verify-email", handleVerifyEmail);
