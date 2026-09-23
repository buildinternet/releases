import { describe, expect, it } from "bun:test";
import { organizations, recommendations, sources } from "@buildinternet/releases-core/schema";
import { createTestApp, createTestDb } from "./setup";

async function makeApp(db = createTestDb(), env: Record<string, unknown> = {}) {
  const { adminRecommendationRoutes } = await import("../src/routes/admin-recommendations.js");
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  return {
    db,
    sent,
    fetch: createTestApp(db, adminRecommendationRoutes, {
      env: {
        WEB_BASE_URL: "https://releases.sh",
        AUTH_EMAIL: {
          send: async (msg: { to: string; subject: string; text: string }) => {
            sent.push(msg);
            return { messageId: "mid" };
          },
        },
        ...env,
      },
    }),
  };
}

async function seedListing(db: ReturnType<typeof createTestDb>) {
  await db.insert(organizations).values({ id: "org_a", slug: "acme", name: "Acme" });
  await db.insert(sources).values({
    id: "src_a",
    orgId: "org_a",
    slug: "changelog",
    name: "Acme Changelog",
    type: "scrape",
    url: "https://acme.test/changelog",
  });
}

async function seedRec(
  db: ReturnType<typeof createTestDb>,
  opts: { id?: string; contactEmail?: string | null; addedNotifiedAt?: number | null } = {},
) {
  await db.insert(recommendations).values({
    id: opts.id ?? "rec_seed",
    createdAt: 1000,
    type: "source",
    url: "https://acme.test/changelog",
    contactEmail: opts.contactEmail === undefined ? "user@example.com" : opts.contactEmail,
    status: "new",
    archived: false,
    surface: "web",
    addedNotifiedAt: opts.addedNotifiedAt ?? null,
  });
}

function notifyAdded(id: string, body: unknown) {
  return new Request(`http://x/v1/admin/recommendations/${id}/notify-added`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /v1/admin/recommendations/:id/notify-added", () => {
  it("sends the added email and stamps addedNotifiedAt", async () => {
    const { db, fetch, sent } = await makeApp();
    await seedListing(db);
    await seedRec(db);

    const res = await fetch(notifyAdded("rec_seed", { orgSlug: "acme", sourceSlug: "changelog" }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      sent: boolean;
      registryUrl: string;
      contactEmail: string;
      notifiedAt: number;
    };
    expect(json.ok).toBe(true);
    expect(json.sent).toBe(true);
    expect(json.registryUrl).toBe("https://releases.sh/acme/changelog");
    expect(json.contactEmail).toBe("user@example.com");
    expect(json.notifiedAt).toBeGreaterThan(0);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("user@example.com");
    expect(sent[0]!.subject).toContain("Acme");
    expect(sent[0]!.text).toContain("https://releases.sh/acme/changelog");
    expect(sent[0]!.text).toContain("Acme Changelog");

    const [row] = await db.select().from(recommendations);
    expect(row!.addedNotifiedAt).toBe(json.notifiedAt);
  });

  it("is idempotent after a successful send", async () => {
    const { db, fetch, sent } = await makeApp();
    await seedListing(db);
    await seedRec(db);

    const first = await fetch(notifyAdded("rec_seed", { orgSlug: "acme" }));
    expect(first.status).toBe(200);
    const replay = await fetch(notifyAdded("rec_seed", { orgSlug: "acme" }));
    expect(replay.status).toBe(200);
    const json = (await replay.json()) as { sent: boolean; reason?: string };
    expect(json.sent).toBe(false);
    expect(json.reason).toBe("already_notified");
    expect(sent).toHaveLength(1);
  });

  it("returns 400 when the recommendation has no contact email", async () => {
    const { db, fetch, sent } = await makeApp();
    await seedListing(db);
    await seedRec(db, { contactEmail: null });

    const res = await fetch(notifyAdded("rec_seed", { orgSlug: "acme" }));
    expect(res.status).toBe(400);
    expect(sent).toHaveLength(0);
    const [row] = await db.select().from(recommendations);
    expect(row!.addedNotifiedAt).toBeNull();
  });

  it("returns already_notified without sending when stamped", async () => {
    const { db, fetch, sent } = await makeApp();
    await seedListing(db);
    await seedRec(db, { addedNotifiedAt: 1_700_000_000_000 });

    const res = await fetch(notifyAdded("rec_seed", { orgSlug: "acme" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      sent: false,
      reason: "already_notified",
      notifiedAt: 1_700_000_000_000,
    });
    expect(sent).toHaveLength(0);
  });

  it("returns 404 for a missing recommendation, org, or source", async () => {
    const { db, fetch } = await makeApp();
    await seedListing(db);
    await seedRec(db);

    const missingRec = await fetch(notifyAdded("rec_missing", { orgSlug: "acme" }));
    expect(missingRec.status).toBe(404);

    const missingOrg = await fetch(notifyAdded("rec_seed", { orgSlug: "nope" }));
    expect(missingOrg.status).toBe(404);

    const missingSource = await fetch(
      notifyAdded("rec_seed", { orgSlug: "acme", sourceSlug: "nope" }),
    );
    expect(missingSource.status).toBe(404);
  });

  it("returns 429 when the hourly added-email budget is exhausted", async () => {
    const db = createTestDb();
    await seedListing(db);
    await seedRec(db, { id: "rec_one" });
    await seedRec(db, { id: "rec_two" });
    const { fetch, sent } = await makeApp(db, { RECOMMENDATION_ADDED_MAX_PER_HOUR: "1" });

    const first = await fetch(notifyAdded("rec_one", { orgSlug: "acme" }));
    const second = await fetch(notifyAdded("rec_two", { orgSlug: "acme" }));
    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(sent).toHaveLength(1);
    const rows = await db.select().from(recommendations);
    expect(rows.find((r) => r.id === "rec_one")!.addedNotifiedAt).not.toBeNull();
    expect(rows.find((r) => r.id === "rec_two")!.addedNotifiedAt).toBeNull();
  });

  it("returns 400 when orgSlug is missing", async () => {
    const { db, fetch } = await makeApp();
    await seedRec(db);
    const res = await fetch(notifyAdded("rec_seed", {}));
    expect(res.status).toBe(400);
  });
});
