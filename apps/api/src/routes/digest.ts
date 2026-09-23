import { Hono, type Context } from "hono";
import { createDb } from "../db.js";
import { unsubscribeByToken } from "../queries/digest-prefs.js";
import type { Env } from "../index.js";
import { respondError } from "../lib/error-response.js";
import { NotFoundError } from "@releases/lib/releases-error";

export const digestRoutes = new Hono<Env>();

/**
 * Public, token-authenticated one-click unsubscribe. The `reld_` token rides in
 * the path (an email client's List-Unsubscribe POST can't send a cookie/header).
 * Any unknown/malformed token → opaque 404 (non-enumerable). Idempotent.
 *
 * POST is the RFC 8058 One-Click target (List-Unsubscribe-Post). GET is the
 * human-clickable confirmation that also unsubscribes.
 */
async function handleUnsubscribe(c: Context<Env>) {
  const raw = c.req.param("token") ?? "";
  const db = createDb(c.env.DB);
  const ok = await unsubscribeByToken(db, raw);
  if (!ok) return respondError(c, new NotFoundError());
  return c.json({ success: true, unsubscribed: true });
}

digestRoutes.post("/digest/unsubscribe/:token", handleUnsubscribe);
digestRoutes.get("/digest/unsubscribe/:token", handleUnsubscribe);
