import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import { user } from "../src/db/schema-auth.js";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { addFollow } from "../src/queries/follows.js";
import { setDigestCadence, getDigestPrefs } from "../src/queries/digest-prefs.js";
import { sendDigests } from "../src/cron/send-digests.js";

let h: TestDatabase;
let sent: Array<{ to: string; subject: string }>;

function env(over: Record<string, unknown> = {}) {
  sent = [];
  return {
    DB: {} as any,
    AUTH_EMAIL: {
      send: async (m: any) => {
        sent.push({ to: m.to, subject: m.subject });
        return { messageId: "m" };
      },
    },
    DIGEST_EMAIL_FROM: "digests@releases.sh",
    WEB_BASE_URL: "https://releases.sh",
    MEDIA_ORIGIN: "https://media.releases.sh",
    DIGEST_MAX_PER_RUN: "100",
    DIGEST_MAX_RELEASES: "50",
    CRON_ENABLED: "true",
    _drizzleOverride: h.db as any,
    ...over,
  } as any;
}

beforeEach(async () => {
  h = createTestDb();
  await h.db.insert(user).values({
    id: "u1",
    name: "T",
    email: "t@e.com",
    emailVerified: true,
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
  await setDigestCadence(h.db, "u1", "daily");
});
afterEach(() => h.cleanup());

describe("sendDigests cron", () => {
  it("sends + advances the watermark when there are new releases", async () => {
    await h.db.insert(releases).values({
      id: "rel_new",
      sourceId: "src_a",
      title: "Shipped",
      content: "x",
      url: "https://a/1",
      publishedAt: new Date(Date.now() + 1000).toISOString(),
      fetchedAt: new Date(Date.now() + 1000).toISOString(),
    });
    // Truncate to whole seconds — the column is mode:"timestamp" (Unix seconds).
    const runStart = new Date(Math.floor((Date.now() + 60_000) / 1000) * 1000);
    await sendDigests(env(), { cadence: "daily", runStart });
    expect(sent.length).toBe(1);
    expect(sent[0].to).toBe("t@e.com");
    expect((await getDigestPrefs(h.db, "u1"))!.lastDigestAt!.getTime()).toBe(runStart.getTime());
  });

  it("no releases → no send, watermark unchanged", async () => {
    const before = (await getDigestPrefs(h.db, "u1"))!.lastDigestAt!.getTime();
    await sendDigests(env(), { cadence: "daily", runStart: new Date(Date.now() + 60_000) });
    expect(sent.length).toBe(0);
    expect((await getDigestPrefs(h.db, "u1"))!.lastDigestAt!.getTime()).toBe(before);
  });

  it("skips unverified recipients", async () => {
    await h.db.update(user).set({ emailVerified: false }).where(eq(user.id, "u1"));
    await h.db.insert(releases).values({
      id: "rel_x",
      sourceId: "src_a",
      title: "X",
      content: "x",
      url: "https://a/x",
      publishedAt: new Date(Date.now() + 1000).toISOString(),
      fetchedAt: new Date(Date.now() + 1000).toISOString(),
    });
    await sendDigests(env(), { cadence: "daily", runStart: new Date(Date.now() + 60_000) });
    expect(sent.length).toBe(0);
  });

  it("no-ops when CRON_ENABLED=false", async () => {
    await sendDigests(env({ CRON_ENABLED: "false" }), { cadence: "daily", runStart: new Date() });
    expect(sent.length).toBe(0);
  });
});
