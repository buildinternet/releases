import { describe, expect, it } from "bun:test";
import { recommendations } from "@buildinternet/releases-core/schema";
import { createTestApp, createTestDb } from "./setup";

async function makeApp(db = createTestDb(), env: Record<string, unknown> = {}) {
  const { recommendationRoutes } = await import("../src/routes/recommendations.js");
  return {
    db,
    fetch: createTestApp(db, recommendationRoutes, {
      env: { SEND_EMAIL: undefined, ...env },
    }),
  };
}

function post(body: unknown) {
  return new Request("http://x/v1/recommendations", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "test-agent" },
    body: JSON.stringify(body),
  });
}

describe("POST /v1/recommendations", () => {
  it("stores a valid URL recommendation and returns 202 + id", async () => {
    const { db, fetch } = await makeApp();
    const res = await fetch(
      post({
        url: "https://example.com/releases",
        note: "This is the public changelog.",
        contactEmail: "user@example.com",
      }),
    );

    expect(res.status).toBe(202);
    const json = (await res.json()) as { ok: boolean; id: string };
    expect(json.ok).toBe(true);
    expect(json.id.startsWith("rec_")).toBe(true);

    const rows = await db.select().from(recommendations);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe("source");
    expect(rows[0]!.url).toBe("https://example.com/releases");
    expect(rows[0]!.note).toBe("This is the public changelog.");
    expect(rows[0]!.contactEmail).toBe("user@example.com");
    expect(rows[0]!.status).toBe("new");
    expect(rows[0]!.archived).toBe(false);
    expect(rows[0]!.userAgent).toBe("test-agent");
  });

  it("accepts a bare URL by adding https", async () => {
    const { db, fetch } = await makeApp();
    const res = await fetch(post({ url: "example.com/changelog" }));
    expect(res.status).toBe(202);
    const rows = await db.select().from(recommendations);
    expect(rows[0]!.url).toBe("https://example.com/changelog");
  });

  it("defaults an omitted type to source and accepts explicit source", async () => {
    const { db, fetch } = await makeApp();
    await fetch(post({ url: "https://example.com/releases" }));
    await fetch(post({ type: "source", url: "https://example.com/changelog" }));
    const rows = await db.select().from(recommendations);
    expect(rows.map((row) => row.type)).toEqual(["source", "source"]);
  });

  it("rejects unsupported recommendation types", async () => {
    const { db, fetch } = await makeApp();
    const res = await fetch(post({ type: "product", url: "https://example.com/releases" }));
    expect(res.status).toBe(400);
    expect(await db.select().from(recommendations)).toHaveLength(0);
  });

  it("rejects non-http URLs", async () => {
    const { db, fetch } = await makeApp();
    const res = await fetch(post({ url: "mailto:zach@releases.sh" }));
    expect(res.status).toBe(400);
    expect(await db.select().from(recommendations)).toHaveLength(0);
  });

  it("rejects invalid contact emails", async () => {
    const { db, fetch } = await makeApp();
    const res = await fetch(post({ url: "https://example.com/releases", contactEmail: "nope" }));
    expect(res.status).toBe(400);
    expect(await db.select().from(recommendations)).toHaveLength(0);
  });

  it("returns 429 when the shared public feedback limiter rejects", async () => {
    const { db, fetch } = await makeApp(undefined, {
      FEEDBACK_RATE_LIMITER: { limit: async () => ({ success: false }) },
    });
    const res = await fetch(post({ url: "https://example.com/releases" }));
    expect(res.status).toBe(429);
    expect(await db.select().from(recommendations)).toHaveLength(0);
  });

  it("returns 503 when RECOMMENDATIONS_DISABLED=true", async () => {
    const { db, fetch } = await makeApp(undefined, { RECOMMENDATIONS_DISABLED: "true" });
    const res = await fetch(post({ url: "https://example.com/releases" }));
    expect(res.status).toBe(503);
    expect(await db.select().from(recommendations)).toHaveLength(0);
  });
});

describe("PATCH /v1/recommendations/:id", () => {
  it("updates status and archived", async () => {
    const { db, fetch } = await makeApp();
    await db.insert(recommendations).values({
      id: "rec_seed",
      createdAt: 1000,
      type: "source",
      url: "https://example.com/releases",
      status: "new",
      archived: false,
      surface: "web",
    });

    const res = await fetch(
      new Request("http://x/v1/recommendations/rec_seed", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "triaged", archived: true }),
      }),
    );

    expect(res.status).toBe(200);
    const [row] = await db.select().from(recommendations);
    expect(row!.status).toBe("triaged");
    expect(row!.archived).toBe(true);
  });
});

describe("DELETE /v1/recommendations/:id", () => {
  it("deletes an existing recommendation", async () => {
    const { db, fetch } = await makeApp();
    await db.insert(recommendations).values({
      id: "rec_seed",
      createdAt: 1000,
      type: "source",
      url: "https://example.com/releases",
      status: "new",
      archived: false,
      surface: "web",
    });

    const res = await fetch(
      new Request("http://x/v1/recommendations/rec_seed", { method: "DELETE" }),
    );

    expect(res.status).toBe(200);
    expect(await db.select().from(recommendations)).toHaveLength(0);
  });

  it("returns 404 for a missing recommendation", async () => {
    const { fetch } = await makeApp();
    const res = await fetch(
      new Request("http://x/v1/recommendations/rec_missing", { method: "DELETE" }),
    );

    expect(res.status).toBe(404);
  });
});
