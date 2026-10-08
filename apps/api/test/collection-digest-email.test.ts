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
import type { DigestCoveredRelease } from "@buildinternet/releases-api-types";
import { setDigestCadence, getDigestPrefs } from "../src/queries/digest-prefs.js";
import {
  listCollectionDigestSubs,
  subscribeCollectionDigest,
  unsubscribeCollectionDigest,
} from "../src/queries/collection-digest-subs.js";
import { upsertCollectionWeeklyDigest } from "../src/queries/collection-summaries.js";
import { sendCollectionDigests } from "../src/cron/send-collection-digests.js";
import { processCollectionDigestMessage } from "../src/queues/collection-digest-consumer.js";
import {
  biggestReleases,
  buildCollectionDigestEmail,
  weekRangeShort,
} from "../src/lib/email/collection-digest-email.js";
import { digestRoutes } from "../src/routes/digest.js";

let h: TestDatabase;
let sent: Array<{ to: string; subject: string; text: string; headers: Record<string, string> }>;

const WEEK = "2026-09-28";
/** ET Monday the week after WEEK, so WEEK is the just-closed week. */
const TODAY = "2026-10-05";

function env(over: Record<string, unknown> = {}) {
  sent = [];
  return {
    DB: {} as D1Database,
    AUTH_EMAIL: {
      send: async (m: any) => {
        sent.push({ to: m.to, subject: m.subject, text: m.text, headers: m.headers });
        return { messageId: "m" };
      },
    },
    WEB_BASE_URL: "https://releases.sh",
    API_BASE_URL: "https://api.releases.sh",
    _drizzleOverride: h.db,
    ...over,
  } as any;
}

async function addUser(id: string, email: string, emailVerified = true) {
  await h.db.insert(user).values({
    id,
    name: id,
    email,
    emailVerified,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

beforeEach(async () => {
  h = createTestDb();
  await addUser("u1", "one@example.com");
  await h.db.insert(organizations).values({ id: "org_a", name: "Acme", slug: "acme" });
  await h.db.insert(sources).values({
    id: "src_a",
    name: "Blog",
    slug: "blog",
    type: "feed",
    url: "https://acme.example.com/blog",
    orgId: "org_a",
  });
  await h.db.insert(releases).values([
    {
      id: "rel_1",
      sourceId: "src_a",
      content: "body",
      title: "Small fix",
      url: "https://acme.example.com/1",
      importance: 2,
    },
    {
      id: "rel_2",
      sourceId: "src_a",
      content: "body",
      title: "Big launch",
      url: "https://acme.example.com/2",
      importance: 5,
    },
    {
      id: "rel_3",
      sourceId: "src_a",
      content: "body",
      title: "Mid change",
      url: "https://acme.example.com/3",
      importance: 3,
    },
  ]);
  await h.db.insert(collections).values([
    { id: "col_ca", slug: "coding-agents", name: "Coding Agents", weeklyDigestEnabled: true },
    { id: "col_off", slug: "no-digest", name: "No Digest" },
  ]);
  await h.db.insert(collectionMembers).values({ collectionId: "col_ca", orgId: "org_a" });
  await upsertCollectionWeeklyDigest(h.db, {
    collectionId: "col_ca",
    weekStart: WEEK,
    title: "Agents ship self-review",
    intro: "A big week for review loops.",
    body: "### Self-review\n\n[Big launch](/release/rel_2) landed.",
    releaseIds: ["rel_1", "rel_2", "rel_3"],
    releaseCount: 3,
    modelId: "test",
  });
});
afterEach(() => h.cleanup());

describe("collection digest subscriptions", () => {
  it("subscribes idempotently, mints a manage token, and lists newest first", async () => {
    expect(await subscribeCollectionDigest(h.db, "u1", "coding-agents")).toEqual({
      collectionSlug: "coding-agents",
    });
    await subscribeCollectionDigest(h.db, "u1", "coding-agents");
    const subs = await listCollectionDigestSubs(h.db, "u1");
    expect(subs.map((s) => s.collectionSlug)).toEqual(["coding-agents"]);
    expect(subs[0].collectionName).toBe("Coding Agents");
    // The reld_ token exists so the email can carry a one-click unsubscribe,
    // without turning the follows digest on.
    const prefs = await getDigestPrefs(h.db, "u1");
    expect(prefs?.manageToken).toStartWith("reld_");
    expect(prefs?.cadence).toBe("off");
  });

  it("refuses a collection without weekly digests or an unknown slug", async () => {
    expect(await subscribeCollectionDigest(h.db, "u1", "no-digest")).toBeNull();
    expect(await subscribeCollectionDigest(h.db, "u1", "nope")).toBeNull();
  });

  it("unsubscribes idempotently", async () => {
    await subscribeCollectionDigest(h.db, "u1", "coding-agents");
    await unsubscribeCollectionDigest(h.db, "u1", "coding-agents");
    await unsubscribeCollectionDigest(h.db, "u1", "coding-agents");
    expect(await listCollectionDigestSubs(h.db, "u1")).toEqual([]);
  });
});

describe("/digest/unsubscribe/:token/collections/:slug", () => {
  function request(path: string) {
    const a = new Hono();
    a.route("/", digestRoutes);
    return a.request(`https://api.releases.sh${path}`, { method: "POST" }, {
      DB: h.db,
    } as any);
  }

  it("removes only that collection and leaves the follows digest on", async () => {
    const prefs = await setDigestCadence(h.db, "u1", "weekly");
    await subscribeCollectionDigest(h.db, "u1", "coding-agents");
    const res = await request(`/digest/unsubscribe/${prefs.manageToken}/collections/coding-agents`);
    expect(res.status).toBe(200);
    expect(await listCollectionDigestSubs(h.db, "u1")).toEqual([]);
    expect((await getDigestPrefs(h.db, "u1"))?.cadence).toBe("weekly");
  });

  it("404s on a bad token", async () => {
    const res = await request(`/digest/unsubscribe/reld_nope/collections/coding-agents`);
    expect(res.status).toBe(404);
  });
});

describe("sendCollectionDigests", () => {
  it("emails each verified subscriber once per week", async () => {
    await addUser("u2", "two@example.com", false);
    await subscribeCollectionDigest(h.db, "u1", "coding-agents");
    await subscribeCollectionDigest(h.db, "u2", "coding-agents");
    const e = env();

    const first = await sendCollectionDigests(
      e,
      [{ collectionId: "col_ca", weekStart: WEEK }],
      TODAY,
    );
    expect(first).toEqual({ enqueued: 1, mode: "inline" });
    expect(sent.map((m) => m.to)).toEqual(["one@example.com"]);
    expect(sent[0].subject).toBe("Agents ship self-review — Coding Agents · Sep 28 – Oct 4");
    expect(sent[0].headers["List-Unsubscribe"]).toContain("/collections/coding-agents>");

    // A workflow replay or a second run finds nobody left for this week.
    const again = await sendCollectionDigests(
      e,
      [{ collectionId: "col_ca", weekStart: WEEK }],
      TODAY,
    );
    expect(again.enqueued).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it("enqueues collection-digest messages when the queue is bound", async () => {
    await subscribeCollectionDigest(h.db, "u1", "coding-agents");
    const queued: unknown[] = [];
    const e = env({
      DIGEST_DELIVERY_QUEUE: {
        sendBatch: async (msgs: { body: unknown }[]) => queued.push(...msgs.map((m) => m.body)),
      },
    });
    await sendCollectionDigests(e, [{ collectionId: "col_ca", weekStart: WEEK }], TODAY);
    expect(queued).toEqual([
      { kind: "collection-digest", userId: "u1", collectionId: "col_ca", weekStart: WEEK },
    ]);
    expect(sent).toHaveLength(0);
  });

  it("does nothing when crons are disabled", async () => {
    await subscribeCollectionDigest(h.db, "u1", "coding-agents");
    const res = await sendCollectionDigests(
      env({ CRON_ENABLED: "false" }),
      [{ collectionId: "col_ca", weekStart: WEEK }],
      TODAY,
    );
    expect(res.mode).toBe("disabled");
    expect(sent).toHaveLength(0);
  });
});

describe("processCollectionDigestMessage", () => {
  const msg = {
    kind: "collection-digest",
    userId: "u1",
    collectionId: "col_ca",
    weekStart: WEEK,
  } as const;

  it("acks a redelivered message without sending twice", async () => {
    await subscribeCollectionDigest(h.db, "u1", "coding-agents");
    const e = env();
    expect(await processCollectionDigestMessage(e, msg)).toBe("ack");
    expect(await processCollectionDigestMessage(e, msg)).toBe("ack");
    expect(sent).toHaveLength(1);
  });

  it("releases the claim on a failed send so a retry can send", async () => {
    await subscribeCollectionDigest(h.db, "u1", "coding-agents");
    const failing = env({
      AUTH_EMAIL: {
        send: async () => {
          throw new Error("boom");
        },
      },
    });
    expect(await processCollectionDigestMessage(failing, msg)).toBe("retry");
    const ok = env();
    expect(await processCollectionDigestMessage(ok, msg)).toBe("ack");
    expect(sent).toHaveLength(1);
  });

  it("acks without sending after the reader unsubscribed", async () => {
    expect(await processCollectionDigestMessage(env(), msg)).toBe("ack");
    expect(sent).toHaveLength(0);
  });
});

describe("buildCollectionDigestEmail", () => {
  const rel = (id: string, title: string, importance: number | null): DigestCoveredRelease => ({
    id,
    title,
    path: `/release/${id}`,
    org: { slug: "acme", name: "Acme", avatarUrl: null, githubHandle: null },
    product: null,
    importance,
  });

  it("formats the week range across a month boundary and within one", () => {
    expect(weekRangeShort("2026-09-28")).toBe("Sep 28 – Oct 4");
    expect(weekRangeShort("2026-09-14")).toBe("Sep 14 – 20");
  });

  it("ranks by importance, keeping citation order on ties", () => {
    const ranked = biggestReleases([
      rel("a", "A", 3),
      rel("b", "B", 5),
      rel("c", "C", 3),
      rel("d", "D", null),
    ]);
    expect(ranked.map((r) => r.id)).toEqual(["b", "a", "c", "d"]);
  });

  it("links rows to their section, offers the replay, and never inlines the body", () => {
    const { text, html } = buildCollectionDigestEmail({
      collection: { slug: "coding-agents", name: "Coding Agents" },
      digest: {
        weekStart: WEEK,
        title: "T",
        intro: "The intro.",
        releases: [
          rel("rel_1", "Small fix", 2),
          rel("rel_2", "Big launch", 5),
          rel("rel_3", "Mid", 3),
        ],
        sections: [{ anchor: "self-review", releaseIds: ["rel_2"] }],
      },
      baseUrl: "https://releases.sh",
      unsubscribeUrl:
        "https://api.releases.sh/v1/digest/unsubscribe/reld_x/collections/coding-agents",
    });
    const digestUrl = "https://releases.sh/collections/coding-agents/digest/2026-09-28";
    expect(text).toContain("The intro.");
    expect(text).toContain(`${digestUrl}#self-review`);
    expect(text).toContain(`${digestUrl}#releases-covered`);
    expect(text).toContain(`${digestUrl}/replay`);
    expect(text).toContain("You subscribed to the Coding Agents weekly digest");
    expect(html).toContain("Read the digest");
    expect(text.indexOf("Big launch")).toBeLessThan(text.indexOf("Small fix"));
  });

  it("skips the replay link for a thin week", () => {
    const { text } = buildCollectionDigestEmail({
      collection: { slug: "c", name: "C" },
      digest: {
        weekStart: WEEK,
        title: "T",
        intro: "I",
        releases: [rel("a", "A", 4)],
        sections: [],
      },
      baseUrl: "https://releases.sh",
      unsubscribeUrl: "https://api.releases.sh/u",
    });
    expect(text).not.toContain("/replay");
  });
});
