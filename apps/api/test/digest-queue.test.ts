import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import { user } from "../src/db/schema-auth.js";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { addFollow } from "../src/queries/follows.js";
import { setDigestCadence, getDigestPrefs } from "../src/queries/digest-prefs.js";
import { sendDigests } from "../src/cron/send-digests.js";
import { processDigestDeliveryMessage } from "../src/queues/digest-consumer.js";

let h: TestDatabase;
let sent: Array<{ to: string; subject: string }>;
let enqueued: Array<{ userId: string; cadence: string; runStart: string }>;

function env(over: Record<string, unknown> = {}) {
  sent = [];
  enqueued = [];
  return {
    DB: {} as any,
    AUTH_EMAIL: {
      send: async (m: any) => {
        sent.push({ to: m.to, subject: m.subject });
        return { messageId: "m" };
      },
    },
    DIGEST_DELIVERY_QUEUE: {
      sendBatch: async (msgs: { body: any }[]) => {
        for (const m of msgs) enqueued.push(m.body);
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

describe("sendDigests queued mode", () => {
  it("enqueues one message per recipient instead of sending inline", async () => {
    const runStart = new Date(Math.floor((Date.now() + 60_000) / 1000) * 1000);
    await sendDigests(env(), { cadence: "daily", runStart });
    expect(enqueued.length).toBe(1);
    expect(enqueued[0].userId).toBe("u1");
    expect(sent.length).toBe(0);
  });
});

describe("processDigestDeliveryMessage", () => {
  it("sends and advances watermark", async () => {
    await h.db.insert(releases).values({
      id: "rel_new",
      sourceId: "src_a",
      title: "Shipped",
      content: "x",
      url: "https://a/1",
      publishedAt: new Date(Date.now() + 1000).toISOString(),
      fetchedAt: new Date(Date.now() + 1000).toISOString(),
    });
    const runStart = new Date(Math.floor((Date.now() + 60_000) / 1000) * 1000);
    const outcome = await processDigestDeliveryMessage(env({ _drizzleOverride: h.db }), {
      userId: "u1",
      cadence: "daily",
      runStart: runStart.toISOString(),
      after: (await getDigestPrefs(h.db, "u1"))!.lastDigestAt?.toISOString() ?? null,
    });
    expect(outcome).toBe("ack");
    expect(sent.length).toBe(1);
    expect((await getDigestPrefs(h.db, "u1"))!.lastDigestAt!.getTime()).toBe(runStart.getTime());
  });

  it("acks without retry when watermark already reached runStart", async () => {
    const runStart = new Date(Math.floor((Date.now() + 60_000) / 1000) * 1000);
    const { advanceDigestWatermark } = await import("../src/queries/digest-prefs.js");
    await advanceDigestWatermark(h.db, "u1", runStart);
    const outcome = await processDigestDeliveryMessage(env({ _drizzleOverride: h.db }), {
      userId: "u1",
      cadence: "daily",
      runStart: runStart.toISOString(),
      after: null,
    });
    expect(outcome).toBe("ack");
    expect(sent.length).toBe(0);
  });
});
