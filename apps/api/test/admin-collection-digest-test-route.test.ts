import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import { user } from "../src/db/schema-auth.js";
import {
  collections,
  collectionMembers,
  organizations,
  releases,
  sources,
} from "@buildinternet/releases-core/schema";
import { upsertCollectionWeeklyDigest } from "../src/queries/collection-summaries.js";
import { subscribeCollectionDigest } from "../src/queries/collection-digest-subs.js";
import { getDigestPrefs } from "../src/queries/digest-prefs.js";
import { userCollectionDigestSubs } from "../src/db/schema-collection-digest-subs.js";
import { adminDigestRoutes } from "../src/routes/admin-digest.js";

let h: TestDatabase;
let sent: Array<{ to: string; subject: string; text: string; headers: Record<string, string> }>;

const WEEK = "2026-09-28";
const BASE = "https://api.releases.sh";

async function post(body: unknown) {
  sent = [];
  const a = new Hono();
  a.route("/", adminDigestRoutes);
  const env = {
    DB: h.db,
    AUTH_EMAIL: {
      send: async (m: any) => {
        sent.push({ to: m.to, subject: m.subject, text: m.text, headers: m.headers });
        return { messageId: "m" };
      },
    },
    DIGEST_EMAIL_FROM: "digests@releases.sh",
    WEB_BASE_URL: "https://releases.sh",
    API_BASE_URL: BASE,
    MEDIA_ORIGIN: "https://media.releases.sh",
  } as unknown as Record<string, unknown>;
  return a.request(
    `${BASE}/admin/digest/collection-test`,
    { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } },
    env,
  );
}

async function addDigest(weekStart: string, title: string) {
  await upsertCollectionWeeklyDigest(h.db, {
    collectionId: "col_ca",
    weekStart,
    title,
    intro: "A big week.",
    body: "### Launch\n\n[Big launch](/release/rel_2) landed.",
    releaseIds: ["rel_1", "rel_2"],
    releaseCount: 2,
    modelId: "test",
  });
}

beforeEach(async () => {
  h = createTestDb();
  // Deliberately UNVERIFIED and UNSUBSCRIBED — the route must not care.
  await h.db.insert(user).values({
    id: "u1",
    name: "T",
    email: "t@e.com",
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await h.db.insert(organizations).values({ id: "org_a", name: "Acme", slug: "acme" });
  await h.db.insert(sources).values({
    id: "src_a",
    name: "Blog",
    slug: "blog",
    type: "feed",
    url: "https://a/blog",
    orgId: "org_a",
  });
  await h.db.insert(releases).values([
    { id: "rel_1", sourceId: "src_a", title: "Small fix", content: "x", url: "https://a/1" },
    {
      id: "rel_2",
      sourceId: "src_a",
      title: "Big launch",
      content: "x",
      url: "https://a/2",
      importance: 5,
    },
  ]);
  await h.db.insert(collections).values({
    id: "col_ca",
    slug: "coding-agents",
    name: "Coding Agents",
    weeklyDigestEnabled: true,
  });
  await h.db.insert(collectionMembers).values({ collectionId: "col_ca", orgId: "org_a" });
  await addDigest(WEEK, "Agents ship self-review");
});
afterEach(() => h.cleanup());

describe("POST /v1/admin/digest/collection-test", () => {
  it("sends the latest real digest to an unsubscribed, unverified user", async () => {
    await addDigest("2026-10-05", "Newer week");
    const res = await post({ collectionSlug: "coding-agents", email: "t@e.com" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.sent).toBe(true);
    expect(json.to).toBe("t@e.com");
    expect(json.weekStart).toBe("2026-10-05");
    expect(json.releaseCount).toBe(2);
    expect(json.subject).toBe(sent[0].subject);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toContain("Newer week");
    expect(sent[0].headers["List-Unsubscribe"]).toContain("/collections/coding-agents>");
  });

  it("honors an explicit weekStart", async () => {
    await addDigest("2026-10-05", "Newer week");
    const res = await post({ collectionSlug: "coding-agents", userId: "u1", weekStart: WEEK });
    const json = (await res.json()) as any;
    expect(json.weekStart).toBe(WEEK);
    expect(sent[0].subject).toContain("Agents ship self-review");
  });

  it("does not create or touch subscription state", async () => {
    await post({ collectionSlug: "coding-agents", email: "t@e.com" });
    expect(await h.db.select().from(userCollectionDigestSubs)).toHaveLength(0);
    // A real subscription's lastSentWeek stays put across a test send.
    await subscribeCollectionDigest(h.db, "u1", "coding-agents");
    const before = await h.db.select().from(userCollectionDigestSubs);
    await post({ collectionSlug: "coding-agents", email: "t@e.com" });
    expect(await h.db.select().from(userCollectionDigestSubs)).toEqual(before);
    expect((await getDigestPrefs(h.db, "u1"))!.lastDigestAt).toBeNull();
  });

  it("404s for an unknown collection", async () => {
    const res = await post({ collectionSlug: "nope", email: "t@e.com" });
    expect(res.status).toBe(404);
    expect(sent).toHaveLength(0);
  });

  it("404s when the collection has no digest for the week", async () => {
    expect(
      (await post({ collectionSlug: "coding-agents", email: "t@e.com", weekStart: "2026-01-05" }))
        .status,
    ).toBe(404);
    await h.db.insert(collections).values({ id: "col_x", slug: "empty", name: "Empty" });
    expect((await post({ collectionSlug: "empty", email: "t@e.com" })).status).toBe(404);
  });

  it("404s for an unknown user", async () => {
    const res = await post({ collectionSlug: "coding-agents", email: "nobody@e.com" });
    expect(res.status).toBe(404);
  });

  it("400s on missing collectionSlug, missing recipient, or a bad weekStart", async () => {
    expect((await post({ email: "t@e.com" })).status).toBe(400);
    expect((await post({ collectionSlug: "coding-agents" })).status).toBe(400);
    expect(
      (await post({ collectionSlug: "coding-agents", email: "t@e.com", weekStart: "last week" }))
        .status,
    ).toBe(400);
  });
});
