import { describe, it, expect } from "bun:test";
import { createTestDb, createTestApp } from "./setup";
import { githubRoutes } from "../src/routes/github";

function secretBinding(value: string) {
  return { get: async () => value };
}

const WEBHOOK_PATH = "/v1/integrations/github/webhook";
const SECRET = "gh-test-webhook-secret";

/** Compute GitHub's `sha256=<hex>` HMAC over the raw body, as the App would. */
async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256=${hex}`;
}

function app() {
  return createTestApp(createTestDb(), githubRoutes, {
    env: { RELEASES_GITHUB_WEBHOOK_SECRET: secretBinding(SECRET) },
  });
}

function post(body: string, headers: Record<string, string>) {
  return new Request(`https://api${WEBHOOK_PATH}`, { method: "POST", headers, body });
}

describe("POST /v1/integrations/github/webhook — plumbing stub", () => {
  it("rejects a missing signature with 401", async () => {
    const res = await app()(
      post(JSON.stringify({ zen: "hi" }), {
        "Content-Type": "application/json",
        "X-GitHub-Event": "ping",
      }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects a wrong signature with 401", async () => {
    const body = JSON.stringify({ zen: "hi" });
    const res = await app()(
      post(body, {
        "Content-Type": "application/json",
        "X-GitHub-Event": "ping",
        "X-Hub-Signature-256": await sign("the-wrong-secret", body),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("acks a correctly-signed ping with pong", async () => {
    const body = JSON.stringify({ zen: "Keep it logically awesome." });
    const res = await app()(
      post(body, {
        "Content-Type": "application/json",
        "X-GitHub-Event": "ping",
        "X-GitHub-Delivery": "11111111-2222-3333-4444-555555555555",
        "X-Hub-Signature-256": await sign(SECRET, body),
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; pong?: boolean };
    expect(json).toEqual({ ok: true, pong: true });
  });

  it("acks an unhandled-but-signed event 200 without erroring", async () => {
    const body = JSON.stringify({ action: "opened" });
    const res = await app()(
      post(body, {
        "Content-Type": "application/json",
        "X-GitHub-Event": "pull_request",
        "X-Hub-Signature-256": await sign(SECRET, body),
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean };
    expect(json).toEqual({ ok: true });
  });

  it("fails closed (401) when the webhook secret is unbound", async () => {
    const noSecretApp = createTestApp(createTestDb(), githubRoutes, { env: {} });
    const body = JSON.stringify({ zen: "hi" });
    const res = await noSecretApp(
      post(body, {
        "Content-Type": "application/json",
        "X-GitHub-Event": "ping",
        "X-Hub-Signature-256": await sign(SECRET, body),
      }),
    );
    expect(res.status).toBe(401);
  });
});
