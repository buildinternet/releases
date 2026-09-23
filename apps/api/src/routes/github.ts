import { Hono } from "hono";
import { constantTimeEqual } from "@buildinternet/releases-core/api-token";
import { getSecret } from "@releases/lib/secrets";
import { logEvent } from "@releases/lib/log-event";
import type { Env } from "../index.js";
import { respondError } from "../lib/error-response.js";
import { UnauthorizedError } from "@releases/lib/releases-error";

export const githubRoutes = new Hono<Env>();

// ---------------------------------------------------------------------------
// Inbound GitHub App webhook receiver — PLUMBING STUB (#1698).
//
// This is the inbound ingress for a future GitHub App that comments changelog
// summaries + breaking-change flags on dependency-bump PRs (#1698). For now it
// only verifies the signature, acks `ping`, and logs the event type — the
// per-event handling is deliberately left as TODOs so the App can be registered
// and exercised end-to-end (install → ping → 200) before any product logic
// lands.
//
// Convention: like the Firecrawl receiver (`routes/firecrawl.ts`), the
// `integrations` namespace is in NEITHER `publicReadRoutes` nor `adminRoutes`,
// so no auth middleware runs — the handler self-authenticates. When a real
// second product behavior lands here, the shared inbound-webhook ingress
// harness (#1247) should absorb the Firecrawl + GitHub receiver boilerplate;
// until then this stays a small self-contained sibling rather than a premature
// abstraction.
// ---------------------------------------------------------------------------

/**
 * Verify GitHub's `X-Hub-Signature-256` header: `sha256=<hex>` where the hex is
 * the HMAC-SHA256 of the RAW request body keyed by the App's webhook secret.
 * The comparison is constant-time to avoid a signature-forgery timing oracle.
 *
 * Must run over the raw bytes GitHub signed — re-serializing a parsed JSON body
 * would change whitespace/key order and never match — so the caller passes the
 * untouched body string.
 */
async function verifyGitHubSignature(
  secret: string,
  rawBody: string,
  header: string | undefined,
): Promise<boolean> {
  if (!header || !header.startsWith("sha256=")) return false;
  const provided = header.slice("sha256=".length);

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expected = [...new Uint8Array(sigBytes)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return constantTimeEqual(provided, expected);
}

githubRoutes.post("/integrations/github/webhook", async (c) => {
  const env = c.env as Env["Bindings"];

  // Read the raw body up front — the signature is computed over these exact
  // bytes, so we cannot use c.req.json() (which would consume + reparse it).
  const rawBody = await c.req.text();

  // Auth: verify the HMAC signature BEFORE any parsing or DB work, so an
  // unauthenticated caller learns nothing about what we do with the payload.
  const secret = await getSecret(env.RELEASES_GITHUB_WEBHOOK_SECRET);
  const signature = c.req.header("X-Hub-Signature-256");
  if (!secret || !(await verifyGitHubSignature(secret, rawBody, signature))) {
    return respondError(c, new UnauthorizedError());
  }

  // GitHub stamps every delivery with the event type and a unique delivery id
  // (the idempotency key when real processing lands — redeliveries reuse it).
  const event = c.req.header("X-GitHub-Event") ?? "unknown";
  const deliveryId = c.req.header("X-GitHub-Delivery") ?? null;

  // `ping` is sent once when the webhook is first configured — ack it so the
  // App registration shows a green check.
  if (event === "ping") {
    logEvent("info", { component: "github-webhook", event: "ping", deliveryId });
    return c.json({ ok: true, pong: true });
  }

  // Parse only after the signature check passed. Malformed JSON on a
  // correctly-signed body is anomalous; log and ack so GitHub doesn't retry.
  let payload: { action?: string } = {};
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    logEvent("warn", {
      component: "github-webhook",
      event: "bad-json",
      ghEvent: event,
      deliveryId,
    });
    return c.json({ ok: true, skipped: "bad_json" });
  }

  switch (event) {
    case "pull_request":
      // TODO(#1698): on opened/synchronize, diff the PR's lockfile/manifest for
      // dependency bumps, call upgrade_plan (#1697), and post/update a sticky
      // changelog + breaking-change comment. No-op for now.
      logEvent("info", {
        component: "github-webhook",
        event: "received",
        ghEvent: event,
        action: payload.action ?? null,
        deliveryId,
        handled: false,
      });
      break;

    case "installation":
    case "installation_repositories":
      // TODO(#1698): track App install/uninstall + repo scope changes so we
      // know which repos are opted in. No-op for now.
      logEvent("info", {
        component: "github-webhook",
        event: "received",
        ghEvent: event,
        action: payload.action ?? null,
        deliveryId,
        handled: false,
      });
      break;

    default:
      // Unhandled event types are acked, not errored — the App may be
      // subscribed to more than we process yet.
      logEvent("info", {
        component: "github-webhook",
        event: "ignored",
        ghEvent: event,
        deliveryId,
      });
  }

  return c.json({ ok: true });
});
