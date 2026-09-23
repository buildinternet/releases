import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { adminEmailsRoutes } from "../src/routes/admin-emails.js";
import {
  EMAIL_SAMPLE_CATALOG,
  renderEmailSample,
  sendEmailSample,
} from "../src/lib/email-samples.js";

const BASE = "http://test";

function app() {
  const h = new Hono();
  h.route("/v1", adminEmailsRoutes);
  return h;
}

describe("GET /v1/admin/emails/samples", () => {
  it("lists every catalogued sample", async () => {
    const res = await app().request(`${BASE}/v1/admin/emails/samples`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { samples: typeof EMAIL_SAMPLE_CATALOG };
    expect(body.samples.length).toBe(EMAIL_SAMPLE_CATALOG.length);
    expect(body.samples.some((s) => s.id === "auth.verify")).toBe(true);
  });
});

describe("POST /v1/admin/emails/test", () => {
  it("rejects unknown types", async () => {
    const res = await app().request(`${BASE}/v1/admin/emails/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "nope", to: "a@b.com" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects invalid recipient addresses", async () => {
    const res = await app().request(`${BASE}/v1/admin/emails/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "auth.verify", to: "not-an-email" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("renderEmailSample", () => {
  it("renders every catalog entry without throwing", () => {
    const env = { WEB_BASE_URL: "https://releases.sh", API_BASE_URL: "https://api.releases.sh" };
    for (const sample of EMAIL_SAMPLE_CATALOG) {
      const rendered = renderEmailSample(env, sample.id);
      expect(rendered.subject.length).toBeGreaterThan(0);
      expect(rendered.text.length).toBeGreaterThan(0);
    }
  });
});

describe("sendEmailSample", () => {
  it("returns no_auth_binding when AUTH_EMAIL is absent", async () => {
    const res = await sendEmailSample({}, "auth.verify", "u@example.com");
    expect(res).toEqual({ sent: false, channel: "auth", reason: "no_auth_binding" });
  });
});
