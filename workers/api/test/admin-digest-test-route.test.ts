import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import { user } from "../src/db/schema-auth.js";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { addFollow } from "../src/queries/follows.js";
import { getDigestPrefs, setDigestCadence } from "../src/queries/digest-prefs.js";
import { adminDigestRoutes } from "../src/routes/admin-digest.js";

let h: TestDatabase;
let sent: Array<{ to: string; subject: string }>;

function app() {
  sent = [];
  const a = new Hono();
  a.onError((err, c) => {
    if (err instanceof HTTPException) {
      const status = err.status;
      return c.json(
        { error: status === 400 ? "bad_request" : "http_error", message: err.message },
        status,
      );
    }
    return c.json({ error: "internal_error", message: String(err) }, 500);
  });
  a.route("/", adminDigestRoutes);
  const env = {
    DB: h.db,
    AUTH_EMAIL: {
      send: async (m: any) => {
        sent.push({ to: m.to, subject: m.subject });
        return { messageId: "m" };
      },
    },
    DIGEST_EMAIL_FROM: "digests@releases.sh",
    WEB_BASE_URL: "https://releases.sh",
    MEDIA_ORIGIN: "https://media.releases.sh",
  } as unknown as Record<string, unknown>;
  return { a, env };
}
const BASE = "https://api.releases.sh";

async function post(body: unknown) {
  const { a, env } = app();
  return a.request(
    `${BASE}/admin/digest/test`,
    { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } },
    env,
  );
}

beforeEach(async () => {
  h = createTestDb();
  // Deliberately UNVERIFIED — the test route must not filter on verification.
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
  await addFollow(h.db, "u1", "org", "org_a");
  await h.db.insert(releases).values({
    id: "rel_recent",
    sourceId: "src_a",
    title: "Shipped",
    content: "x",
    url: "https://a/1",
    // Ingested a day ago, not "now": the digest window is on fetched_at, so a
    // just-fetched row would sit inside even the narrowest `sinceDays` window.
    publishedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
    fetchedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
  });
});
afterEach(() => h.cleanup());

describe("POST /v1/admin/digest/test", () => {
  it("sends to an unverified user resolved by email, without touching the watermark", async () => {
    const res = await post({ email: "t@e.com" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.sent).toBe(true);
    expect(json.to).toBe("t@e.com");
    expect(json.releaseCount).toBe(1);
    expect(json.advancedWatermark).toBe(false);
    expect(sent.length).toBe(1);
    // ensureDigestPrefs created an off row with no watermark; it stays put.
    const prefs = await getDigestPrefs(h.db, "u1");
    expect(prefs!.cadence).toBe("off");
    expect(prefs!.lastDigestAt).toBeNull();
  });

  it("resolves by userId and advances the watermark when asked", async () => {
    const res = await post({ userId: "u1", advanceWatermark: true });
    const json = (await res.json()) as any;
    expect(json.sent).toBe(true);
    expect(json.advancedWatermark).toBe(true);
    expect((await getDigestPrefs(h.db, "u1"))!.lastDigestAt).not.toBeNull();
  });

  it("reports no_releases when the window is empty (and never errors)", async () => {
    const res = await post({ email: "t@e.com", sinceDays: 0.0001 });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.sent).toBe(false);
    expect(json.reason).toBe("no_releases");
    expect(sent.length).toBe(0);
  });

  it("400s when neither userId nor email is given", async () => {
    const res = await post({ cadence: "weekly" });
    expect(res.status).toBe(400);
  });

  it("400s on a non-positive sinceDays", async () => {
    const res = await post({ email: "t@e.com", sinceDays: -3 });
    expect(res.status).toBe(400);
  });

  it("404s for an unknown user", async () => {
    const res = await post({ email: "nobody@e.com" });
    expect(res.status).toBe(404);
  });

  it("preserves an existing cadence/token instead of overwriting it", async () => {
    const before = await setDigestCadence(h.db, "u1", "weekly");
    await post({ userId: "u1" });
    const after = await getDigestPrefs(h.db, "u1");
    expect(after!.cadence).toBe("weekly");
    expect(after!.manageToken).toBe(before.manageToken);
  });

  it("400s on malformed JSON with invalid JSON body", async () => {
    const { a, env } = app();
    const res = await a.request(
      `${BASE}/admin/digest/test`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      },
      env,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; message: string };
    expect(json.error).toBe("bad_request");
    expect(json.message).toBe("invalid JSON body");
  });
});
