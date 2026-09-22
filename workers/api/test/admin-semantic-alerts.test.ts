import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { organizations, releases, sources } from "@buildinternet/releases-core/schema";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import { user } from "../src/db/schema-auth.js";
import { userFollows } from "../src/db/schema-follows.js";
import { semanticAlerts } from "../src/db/schema-semantic-alerts.js";
import { adminSemanticAlertsRoutes } from "../src/routes/admin-semantic-alerts.js";
import { adminRoutes } from "../src/route-namespaces.js";
import {
  SEMANTIC_ALERT_DEMO_ORG_SLUG,
  SEMANTIC_ALERT_DEMO_SOURCE_CAP,
  SEMANTIC_ALERT_DEMO_SOURCE_SLUG,
  SEMANTIC_ALERT_DEMO_TITLE_PREFIX,
  generateDemoReleases,
  runSemanticAlertPreview,
} from "../src/lib/semantic-alert-demo.js";
import type { D1Db } from "../src/db.js";

const BASE = "http://test";

let h: TestDatabase;
const hubBodies: Array<{ events?: Array<{ title?: string }> }> = [];
const queued: Array<{
  events?: Array<{ type?: string; release?: { id?: string } }>;
  owners?: Array<{ sourceId?: string; orgId?: string }>;
}> = [];

function env() {
  return {
    DB: h.db,
    RELEASES_INDEX: {},
    RELEASE_HUB: {
      idFromName: () => "global",
      get: () => ({
        fetch: async (req: Request) => {
          hubBodies.push((await req.json()) as { events?: Array<{ title?: string }> });
          return new Response(null, { status: 204 });
        },
      }),
    },
    RELEASE_EVENTS_QUEUE: {
      send: async (message: (typeof queued)[number]) => {
        queued.push(message);
      },
    },
  };
}

function app() {
  const a = new Hono();
  a.route("/v1", adminSemanticAlertsRoutes);
  return a;
}

async function post(path: string, body: unknown) {
  return app().request(
    `${BASE}${path}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env(),
  );
}

beforeEach(() => {
  h = createTestDb();
  hubBodies.length = 0;
  queued.length = 0;
});

afterEach(() => h.cleanup());

describe("generateDemoReleases", () => {
  it("is deterministic for a seed and prefixes every title", () => {
    const a = generateDemoReleases(4, "slack", "src_demo");
    const b = generateDemoReleases(4, "slack", "src_demo");
    expect(a.map((row) => row.title)).toEqual(b.map((row) => row.title));
    expect(a.map((row) => row.theme)).toEqual(b.map((row) => row.theme));
    expect(new Set(a.map((row) => row.theme)).size).toBe(4);
    for (const row of a) {
      expect(row.title.startsWith(SEMANTIC_ALERT_DEMO_TITLE_PREFIX)).toBe(true);
      expect(row.content.length).toBeGreaterThan(40);
      expect(row.url).toContain("src_demo");
    }
    expect(a[0]!.url).not.toBe(b[0]!.url);
  });
});

describe("admin route gate", () => {
  it("registers the preview namespace as admin-only", () => {
    expect(adminRoutes).toContain("admin/semantic-alerts");
  });
});

describe("POST /v1/admin/semantic-alerts/preview", () => {
  it("rejects counts outside 1–20 and non-integers", async () => {
    for (const count of [0, 21, -1, 1.5, "5"]) {
      const res = await post("/v1/admin/semantic-alerts/preview", { count });
      expect(res.status).toBe(400);
    }
  });

  it("rejects a bare source slug", async () => {
    const res = await post("/v1/admin/semantic-alerts/preview", {
      sourceId: "changelog",
      count: 1,
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown source and does not create the demo org", async () => {
    const res = await post("/v1/admin/semantic-alerts/preview", {
      sourceId: "src_missing",
      count: 1,
    });
    expect(res.status).toBe(404);
    const orgs = await h.db
      .select()
      .from(organizations)
      .where(eq(organizations.slug, SEMANTIC_ALERT_DEMO_ORG_SLUG));
    expect(orgs).toHaveLength(0);
  });

  it("inserts onto the dedicated demo source and publishes release.created", async () => {
    const res = await post("/v1/admin/semantic-alerts/preview", { count: 3, seed: "demo-seed" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      inserted: number;
      published: number;
      seed: string;
      source: {
        id: string;
        slug: string;
        orgSlug: string;
        demo: boolean;
        followsEligible: boolean;
      };
      releases: Array<{ id: string; title: string; theme: string }>;
      matcher: { status: string; reason?: string; userId: string | null; matches: unknown[] };
      cleanup: { path: string; sourceId: string };
    };
    expect(body.inserted).toBe(3);
    expect(body.published).toBe(3);
    expect(body.seed).toBe("demo-seed");
    expect(body.source.demo).toBe(true);
    expect(body.source.followsEligible).toBe(true);
    expect(body.source.orgSlug).toBe(SEMANTIC_ALERT_DEMO_ORG_SLUG);
    expect(body.source.slug).toBe(SEMANTIC_ALERT_DEMO_SOURCE_SLUG);
    expect(body.matcher).toEqual({
      status: "skipped",
      reason: "user_not_requested",
      userId: null,
      matches: [],
    });
    expect(body.cleanup.sourceId).toBe(body.source.id);

    const rows = await h.db.select().from(releases).where(eq(releases.sourceId, body.source.id));
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.title.startsWith(SEMANTIC_ALERT_DEMO_TITLE_PREFIX)).toBe(true);
      expect(row.summary).toBeNull();
      const meta = JSON.parse(row.metadata ?? "{}") as { semanticAlertDemo?: boolean };
      expect(meta.semanticAlertDemo).toBe(true);
    }

    const [org] = await h.db
      .select()
      .from(organizations)
      .where(eq(organizations.slug, SEMANTIC_ALERT_DEMO_ORG_SLUG));
    expect(org?.featured).toBe(false);
    expect(org?.fetchPaused).toBe(true);
    expect(org?.isHidden).toBe(false);

    const [source] = await h.db.select().from(sources).where(eq(sources.id, body.source.id));
    expect(source?.fetchPriority).toBe("paused");
    expect(source?.isHidden).toBe(false);

    expect(hubBodies).toHaveLength(1);
    const titles = (hubBodies[0]?.events ?? []).map((event) => event.title);
    expect(titles).toHaveLength(3);
    expect(titles.every((title) => title?.startsWith(SEMANTIC_ALERT_DEMO_TITLE_PREFIX))).toBe(true);

    expect(queued).toHaveLength(1);
    expect(queued[0]?.events?.every((event) => event.type === "release.created")).toBe(true);
    expect(queued[0]?.owners?.every((owner) => owner.sourceId === body.source.id)).toBe(true);
    expect(queued[0]?.owners?.[0]?.orgId).toBe(org?.id);

    const again = await post("/v1/admin/semantic-alerts/preview", { count: 1, seed: "other" });
    const againBody = (await again.json()) as { source: { id: string } };
    expect(againBody.source.id).toBe(body.source.id);
  });

  it("writes an explicit source without creating the demo org", async () => {
    await h.db.insert(organizations).values({
      id: "org_explicit00000000001",
      slug: "acme",
      name: "Acme",
      featured: true,
    });
    await h.db.insert(sources).values({
      id: "src_explicit00000000001",
      orgId: "org_explicit00000000001",
      slug: "changelog",
      name: "Acme changelog",
      type: "feed",
      url: "https://acme.example/changelog",
    });

    const res = await post("/v1/admin/semantic-alerts/preview", {
      count: 2,
      sourceId: "acme/changelog",
      seed: "explicit",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      source: { id: string; demo: boolean; orgSlug: string };
      inserted: number;
    };
    expect(body.inserted).toBe(2);
    expect(body.source.demo).toBe(false);
    expect(body.source.id).toBe("src_explicit00000000001");
    expect(body.source.orgSlug).toBe("acme");

    const demoOrgs = await h.db
      .select()
      .from(organizations)
      .where(eq(organizations.slug, SEMANTIC_ALERT_DEMO_ORG_SLUG));
    expect(demoOrgs).toHaveLength(0);

    const byId = await post("/v1/admin/semantic-alerts/preview", {
      count: 1,
      sourceId: "src_explicit00000000001",
    });
    expect(byId.status).toBe(200);
  });

  it("does not reuse a non-demo org that already owns the demo slug", async () => {
    await h.db.insert(organizations).values({
      id: "org_squat0000000000001",
      slug: SEMANTIC_ALERT_DEMO_ORG_SLUG,
      name: "Not the demo",
      metadata: "{}",
    });
    const res = await post("/v1/admin/semantic-alerts/preview", { count: 1 });
    expect(res.status).toBe(409);
    const rows = await h.db.select().from(releases);
    expect(rows).toHaveLength(0);
  });

  it("returns 404 for an unknown user before inserting", async () => {
    const res = await post("/v1/admin/semantic-alerts/preview", { count: 1, userId: "missing" });
    expect(res.status).toBe(404);
    expect(await h.db.select().from(releases)).toHaveLength(0);
    expect(hubBodies).toHaveLength(0);
  });

  it("scores an empty candidate set once the matcher is wired", async () => {
    await h.db.insert(user).values({
      id: "user_preview",
      name: "Preview",
      email: "preview@example.com",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await post("/v1/admin/semantic-alerts/preview", {
      count: 1,
      userId: "user_preview",
      seed: "match",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      matcher: { status: string; reason?: string; userId: string; matches: unknown[] };
    };
    expect(body.matcher.status).toBe("scored");
    expect(body.matcher.matches).toEqual([]);
    expect(body.matcher.userId).toBe("user_preview");
    expect(body.matcher.reason).toBeUndefined();
  });

  it("reports model_unavailable when eligible alerts exist but OpenRouter is unbound", async () => {
    await h.db.insert(user).values({
      id: "user_model",
      name: "Model",
      email: "model@example.com",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const bootstrap = await post("/v1/admin/semantic-alerts/preview", { count: 1, seed: "boot" });
    expect(bootstrap.status).toBe(200);
    const bootBody = (await bootstrap.json()) as { follow: { targetId: string } };
    const now = new Date();
    await h.db.insert(userFollows).values({
      id: "uf_model_org",
      userId: "user_model",
      targetType: "org",
      targetId: bootBody.follow.targetId,
      createdAt: now,
    });
    await h.db.insert(semanticAlerts).values({
      id: "sal_model",
      userId: "user_model",
      query: "Slack integrations with B2B software",
      enabled: true,
      threshold: 0.8,
      deliverEmail: true,
      deliverWebhook: false,
      webhookSubscriptionId: null,
      createdAt: now,
      updatedAt: now,
    });
    const res = await post("/v1/admin/semantic-alerts/preview", {
      count: 1,
      userId: "user_model",
      seed: "model",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      matcher: { status: string; reason?: string; userId: string };
    };
    expect(body.matcher.status).toBe("unavailable");
    expect(body.matcher.reason).toBe("model_unavailable");
    expect(body.matcher.userId).toBe("user_model");
  });

  it("returns scored matches when a matcher is injected", async () => {
    await h.db.insert(user).values({
      id: "user_scored",
      name: "Scored",
      email: "scored@example.com",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const result = await runSemanticAlertPreview(
      h.db as unknown as D1Db,
      env() as never,
      {
        count: 1,
        userId: "user_scored",
        seed: "scored",
      },
      {
        match: async (_db, _userId, rows, _env) => ({
          status: "scored",
          matches: [
            {
              alertId: "sal_1",
              releaseId: rows[0]!.id,
              probability: 0.91,
              matched: true,
              threshold: 0.8,
            },
          ],
        }),
      },
    );
    expect(result.matcher.status).toBe("scored");
    expect(result.matcher.matches).toEqual([
      {
        alertId: "sal_1",
        releaseId: result.releases[0]!.id,
        probability: 0.91,
        matched: true,
        threshold: 0.8,
      },
    ]);
  });

  it("refuses to grow the demo source past the standing cap", async () => {
    const first = await post("/v1/admin/semantic-alerts/preview", { count: 1, seed: "cap" });
    const created = (await first.json()) as { source: { id: string } };
    const extras = Array.from({ length: SEMANTIC_ALERT_DEMO_SOURCE_CAP - 1 }, (_, i) => ({
      id: `rel_cap${String(i).padStart(18, "0")}`,
      sourceId: created.source.id,
      title: `${SEMANTIC_ALERT_DEMO_TITLE_PREFIX}cap ${i}`,
      content: "synthetic",
      url: `https://demo.releases.invalid/cap/${i}`,
      metadata: JSON.stringify({ semanticAlertDemo: true }),
    }));
    await h.db.insert(releases).values(extras);

    const res = await post("/v1/admin/semantic-alerts/preview", { count: 1, seed: "cap-2" });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string; details?: { cap?: number } } };
    expect(body.error.code).toBe("limit_exceeded");
    expect(body.error.details?.cap).toBe(SEMANTIC_ALERT_DEMO_SOURCE_CAP);
  });
});

describe("POST /v1/admin/semantic-alerts/purge", () => {
  it("deletes flagged rows and leaves real releases on the same source", async () => {
    const created = await post("/v1/admin/semantic-alerts/preview", { count: 2, seed: "purge" });
    const body = (await created.json()) as { source: { id: string } };
    await h.db.insert(releases).values({
      id: "rel_real000000000000001",
      sourceId: body.source.id,
      title: "Real changelog entry",
      content: "Shipped to customers.",
      url: "https://demo.releases.invalid/real",
      metadata: "{}",
    });

    const res = await post("/v1/admin/semantic-alerts/purge", {});
    expect(res.status).toBe(200);
    const purged = (await res.json()) as { deleted: number; sourceId: string };
    expect(purged.deleted).toBe(2);
    expect(purged.sourceId).toBe(body.source.id);

    const remaining = await h.db.select().from(releases);
    expect(remaining.map((row) => row.id)).toEqual(["rel_real000000000000001"]);
  });

  it("all:true removes flagged rows on every source", async () => {
    await post("/v1/admin/semantic-alerts/preview", { count: 1, seed: "all" });
    await h.db.insert(organizations).values({
      id: "org_other0000000000001",
      slug: "other",
      name: "Other",
    });
    await h.db.insert(sources).values({
      id: "src_other00000000000001",
      orgId: "org_other0000000000001",
      slug: "notes",
      name: "Notes",
      type: "feed",
      url: "https://other.example/notes",
    });
    await h.db.insert(releases).values({
      id: "rel_otherdemo0000000001",
      sourceId: "src_other00000000000001",
      title: `${SEMANTIC_ALERT_DEMO_TITLE_PREFIX}elsewhere`,
      content: "synthetic",
      url: "https://other.example/demo",
      metadata: JSON.stringify({ semanticAlertDemo: true }),
    });
    await h.db.insert(releases).values({
      id: "rel_otherreal0000000001",
      sourceId: "src_other00000000000001",
      title: "Keep me",
      content: "real",
      url: "https://other.example/real",
      metadata: "{}",
    });

    const res = await post("/v1/admin/semantic-alerts/purge", { all: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: number };
    expect(body.deleted).toBe(2);
    const remaining = await h.db.select({ id: releases.id }).from(releases);
    expect(remaining.map((row) => row.id)).toEqual(["rel_otherreal0000000001"]);
  });
});
