import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  organizations,
  products,
  releases,
  sources,
  webhookSubscriptions,
} from "@buildinternet/releases-core/schema";
import type { NoulBatchModel, NoulBatchRequest } from "@releases/ai-internal/decision-model";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import { user } from "../src/db/schema-auth.js";
import { userFollows } from "../src/db/schema-follows.js";
import { semanticAlertMatches, semanticAlerts } from "../src/db/schema-semantic-alerts.js";
import type { ReleaseEvent } from "../src/events/types.js";
import { publishReleaseEvents } from "../src/events/publish.js";
import { listSemanticAlertCandidates } from "../src/queries/semantic-alerts.js";
import { runSemanticAlertMatch, type SemanticAlertEnv } from "../src/semantic-alerts/run.js";
import { encodeSemanticAlertPoint } from "../src/semantic-alerts/analytics.js";

const QUERY = "Slack integrations with B2B software";

let h: TestDatabase;

beforeEach(() => {
  h = createTestDb();
});

afterEach(() => h.cleanup());

async function seedUser(id: string, email = `${id}@example.com`) {
  await h.db.insert(user).values({
    id,
    name: id,
    email,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function seedCatalog() {
  await h.db.insert(organizations).values({ id: "org_a", name: "Acme", slug: "acme" });
  await h.db.insert(products).values({
    id: "prd_a",
    name: "Acme App",
    slug: "app",
    orgId: "org_a",
  });
  await h.db.insert(sources).values({
    id: "src_a",
    name: "Changelog",
    slug: "changelog",
    type: "feed",
    url: "https://example.com/changelog",
    orgId: "org_a",
    productId: "prd_a",
  });
  await h.db.insert(releases).values({
    id: "rel_a",
    sourceId: "src_a",
    title: "Slack for finance teams",
    content: "y".repeat(20),
    summary: "Connect Slack to approvals",
    url: "https://example.com/slack",
    publishedAt: new Date().toISOString(),
    fetchedAt: new Date().toISOString(),
  });
}

async function follow(userId: string, targetType: "org" | "product", targetId: string) {
  await h.db.insert(userFollows).values({
    id: `uf_${userId}_${targetType}_${targetId}`,
    userId,
    targetType,
    targetId,
    createdAt: new Date(),
  });
}

async function alert(opts: {
  id: string;
  userId: string;
  query?: string;
  enabled?: boolean;
  threshold?: number;
  deliverEmail?: boolean;
  deliverWebhook?: boolean;
  webhookSubscriptionId?: string | null;
}) {
  const now = new Date();
  await h.db.insert(semanticAlerts).values({
    id: opts.id,
    userId: opts.userId,
    query: opts.query ?? QUERY,
    enabled: opts.enabled ?? true,
    threshold: opts.threshold ?? 0.8,
    deliverEmail: opts.deliverEmail ?? true,
    deliverWebhook: opts.deliverWebhook ?? false,
    webhookSubscriptionId: opts.webhookSubscriptionId ?? null,
    createdAt: now,
    updatedAt: now,
  });
}

function event(): ReleaseEvent {
  return {
    id: "evt_a",
    seq: 1,
    ts: 1,
    type: "release.created",
    release: {
      id: "rel_a",
      title: "Slack for finance teams",
      version: null,
      publishedAt: null,
      sourceName: "Changelog",
      sourceSlug: "changelog",
      summary: null,
      titleGenerated: null,
      titleShort: null,
      media: [],
      contentChars: 20,
      contentTokens: null,
      webUrl: "https://releases.sh/release/rel_a-slack",
    },
  };
}

function scoringModel(probability: number, calls: NoulBatchRequest[] = []): NoulBatchModel {
  return {
    id: "openrouter:typesafe/jev-1.13",
    decideNoul: async (request) => {
      calls.push(request);
      return {
        answers: request.questions.map((question) => ({ id: question.id, probability })),
        usage: { inputTokens: 11, outputTokens: 3, costUsd: 0.00001 },
      };
    },
  };
}

function env(extra: Partial<SemanticAlertEnv> = {}): SemanticAlertEnv {
  return {
    DB: h.db as unknown as D1Database,
    SEMANTIC_ALERTS_ENABLED: "true",
    ENVIRONMENT: "test",
    ...extra,
  };
}

describe("semantic alert prefilter", () => {
  it("keeps follows that cover the release and drops the rest", async () => {
    await seedUser("u1");
    await seedUser("u2");
    await seedUser("u3");
    await seedUser("u4");
    await seedUser("u5");
    await seedCatalog();
    await follow("u1", "org", "org_a");
    await follow("u2", "product", "prd_a");
    await follow("u3", "org", "org_a");
    await follow("u3", "product", "prd_a");
    await follow("u4", "org", "org_other");
    await follow("u5", "org", "org_a");
    await alert({ id: "sal_org", userId: "u1" });
    await alert({ id: "sal_product", userId: "u2", deliverEmail: false, deliverWebhook: true });
    await alert({ id: "sal_both", userId: "u3" });
    await alert({ id: "sal_other", userId: "u4" });
    await alert({ id: "sal_off", userId: "u5", enabled: false });
    await alert({
      id: "sal_silent",
      userId: "u1",
      query: "second interest",
      deliverEmail: false,
      deliverWebhook: false,
    });

    const rows = await listSemanticAlertCandidates(h.db, { orgId: "org_a", productId: "prd_a" });
    expect(rows.map((row) => row.id)).toEqual(["sal_both", "sal_org", "sal_product"]);
  });
});

describe("runSemanticAlertMatch", () => {
  it("does not call the model when the flag is off", async () => {
    await seedUser("u1");
    await seedCatalog();
    await follow("u1", "org", "org_a");
    await alert({ id: "sal_a", userId: "u1" });
    let called = false;
    const sent: string[] = [];
    await runSemanticAlertMatch(
      env({
        SEMANTIC_ALERTS_ENABLED: "false",
        AUTH_EMAIL: {
          send: async (message) => {
            sent.push(message.to);
            return {};
          },
        },
      }),
      {
        sourceName: "Changelog",
        sourceId: "src_a",
        orgId: "org_a",
        productId: "prd_a",
        releases: [{ id: "rel_a", event: event() }],
      },
      {
        resolveModel: async () => {
          called = true;
          return scoringModel(0.99);
        },
      },
    );
    expect(called).toBe(false);
    expect(sent).toEqual([]);
  });

  it("matches at the stored threshold, batches questions, and skips a second send", async () => {
    await seedUser("u1");
    await seedCatalog();
    await follow("u1", "org", "org_a");
    await alert({ id: "sal_a", userId: "u1", threshold: 0.8 });
    await alert({ id: "sal_b", userId: "u1", threshold: 0.9, query: "Mobile SDK releases" });
    await alert({ id: "sal_c", userId: "u1", threshold: 0.99, query: "Billing exports" });
    const calls: NoulBatchRequest[] = [];
    const sent: Array<{ to: string; subject: string; text: string }> = [];
    const points: unknown[] = [];
    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    const base = env({
      AUTH_EMAIL: {
        send: async (message) => {
          sent.push({ to: message.to, subject: message.subject, text: message.text ?? "" });
          return {};
        },
      },
      RELEASE_CLASSIFICATIONS_AE: {
        writeDataPoint(point) {
          points.push(point);
        },
      },
    });
    const input = {
      sourceName: "Changelog",
      sourceId: "src_a",
      orgId: "org_a",
      productId: "prd_a",
      releases: [{ id: "rel_a", event: event() }],
    };
    const deps = {
      questionsPerCall: 2,
      resolveModel: async () => scoringModel(0.85, calls),
    };
    try {
      await runSemanticAlertMatch(base, input, deps);
      expect(calls).toHaveLength(2);
      expect(calls[0]!.questions).toHaveLength(2);
      expect(calls[1]!.questions).toHaveLength(1);
      expect(calls[0]!.state).toContain("Title: Slack for finance teams");
      expect(calls[0]!.state).not.toContain(QUERY);
      expect(calls[0]!.questions.some((question) => question.criteria.true === QUERY)).toBe(true);
      await runSemanticAlertMatch(base, input, deps);
    } finally {
      console.log = original;
    }

    expect(calls).toHaveLength(3);
    expect(calls[2]!.questions.map((question) => question.id)).not.toContain("sal_a");
    expect(sent.map((message) => message.subject)).toEqual([
      "A release matched your alert: Slack for finance teams",
    ]);
    expect(sent[0]!.text).toContain(QUERY);
    expect(sent[0]!.to).toBe("u1@example.com");
    const matches = await h.db.select().from(semanticAlertMatches);
    expect(matches.map((row) => row.alertId)).toEqual(["sal_a"]);
    expect(logs.join("\n")).toContain("semantic-alert-match");
    expect(logs.join("\n")).not.toContain(QUERY);
    expect(JSON.stringify(points)).not.toContain(QUERY);
    expect(JSON.stringify(points)).toContain("semantic-alert");
  });

  it("fails closed when the model throws and does not log the query", async () => {
    await seedUser("u1");
    await seedCatalog();
    await follow("u1", "org", "org_a");
    await alert({ id: "sal_a", userId: "u1", deliverEmail: true, deliverWebhook: true });
    await h.db.insert(webhookSubscriptions).values({
      id: "whk_follows",
      userId: "u1",
      scope: "follows",
      orgId: null,
      url: "https://example.com/hook",
      format: "json",
      enabled: true,
      secretVersion: 1,
      createdAt: new Date().toISOString(),
    });
    const sent: string[] = [];
    const queued: string[] = [];
    const logs: string[] = [];
    const warn = console.warn;
    const error = console.error;
    console.warn = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    console.error = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      await runSemanticAlertMatch(
        env({
          AUTH_EMAIL: {
            send: async (message) => {
              sent.push(message.to);
              return {};
            },
          },
          WEBHOOK_DELIVERY_QUEUE: {
            sendBatch: async (messages: Array<{ body: unknown }>) => {
              for (const message of messages) queued.push(JSON.stringify(message.body));
            },
          } as unknown as Queue<unknown>,
        }),
        {
          sourceName: "Changelog",
          sourceId: "src_a",
          orgId: "org_a",
          productId: "prd_a",
          releases: [{ id: "rel_a", event: event() }],
        },
        {
          resolveModel: async () => ({
            id: "openrouter:typesafe/jev-1.13",
            decideNoul: async () => {
              throw new Error(QUERY);
            },
          }),
        },
      );
    } finally {
      console.warn = warn;
      console.error = error;
    }
    expect(sent).toEqual([]);
    expect(queued).toEqual([]);
    expect(await h.db.select().from(semanticAlertMatches)).toEqual([]);
    expect(logs.join("\n")).not.toContain(QUERY);
  });

  it("delivers the linked webhook, not the follows subscription", async () => {
    await seedUser("u1");
    await seedCatalog();
    await follow("u1", "org", "org_a");
    await h.db.insert(webhookSubscriptions).values([
      {
        id: "whk_follows",
        userId: "u1",
        scope: "follows",
        orgId: null,
        url: "https://example.com/follows",
        format: "json",
        enabled: true,
        secretVersion: 1,
        createdAt: new Date().toISOString(),
      },
      {
        id: "whk_linked",
        userId: "u1",
        scope: "org",
        orgId: "org_a",
        url: "https://example.com/linked",
        format: "json",
        enabled: true,
        secretVersion: 2,
        createdAt: new Date().toISOString(),
      },
    ]);
    await alert({
      id: "sal_a",
      userId: "u1",
      deliverEmail: false,
      deliverWebhook: true,
      webhookSubscriptionId: "whk_linked",
    });
    const urls: string[] = [];
    await runSemanticAlertMatch(
      env({
        WEBHOOK_DELIVERY_QUEUE: {
          sendBatch: async (messages: Array<{ body: { url: string } }>) => {
            for (const message of messages) {
              urls.push(message.body.url);
            }
          },
        } as unknown as Queue<unknown>,
      }),
      {
        sourceName: "Changelog",
        sourceId: "src_a",
        orgId: "org_a",
        productId: "prd_a",
        releases: [{ id: "rel_a", event: event() }],
      },
      { resolveModel: async () => scoringModel(0.95) },
    );
    expect(urls).toEqual(["https://example.com/linked"]);
  });

  it("uses the follows subscription when the alert has no linked webhook", async () => {
    await seedUser("u1");
    await seedCatalog();
    await follow("u1", "org", "org_a");
    await h.db.insert(webhookSubscriptions).values({
      id: "whk_follows",
      userId: "u1",
      scope: "follows",
      orgId: null,
      url: "https://example.com/follows",
      format: "json",
      enabled: true,
      secretVersion: 1,
      createdAt: new Date().toISOString(),
    });
    await alert({
      id: "sal_a",
      userId: "u1",
      deliverEmail: false,
      deliverWebhook: true,
    });
    const urls: string[] = [];
    await runSemanticAlertMatch(
      env({
        WEBHOOK_DELIVERY_QUEUE: {
          sendBatch: async (messages: Array<{ body: { url: string } }>) => {
            for (const message of messages) urls.push(message.body.url);
          },
        } as unknown as Queue<unknown>,
      }),
      {
        sourceName: "Changelog",
        sourceId: "src_a",
        orgId: "org_a",
        productId: "prd_a",
        releases: [{ id: "rel_a", event: event() }],
      },
      { resolveModel: async () => scoringModel(0.95) },
    );
    expect(urls).toEqual(["https://example.com/follows"]);
  });

  it("does not fall back when the linked subscription is disabled", async () => {
    await seedUser("u1");
    await seedCatalog();
    await follow("u1", "org", "org_a");
    await h.db.insert(webhookSubscriptions).values([
      {
        id: "whk_follows",
        userId: "u1",
        scope: "follows",
        orgId: null,
        url: "https://example.com/follows",
        format: "json",
        enabled: true,
        secretVersion: 1,
        createdAt: new Date().toISOString(),
      },
      {
        id: "whk_linked",
        userId: "u1",
        scope: "org",
        orgId: "org_a",
        url: "https://example.com/linked",
        format: "json",
        enabled: false,
        secretVersion: 1,
        createdAt: new Date().toISOString(),
      },
    ]);
    await alert({
      id: "sal_a",
      userId: "u1",
      deliverEmail: false,
      deliverWebhook: true,
      webhookSubscriptionId: "whk_linked",
    });
    const urls: string[] = [];
    await runSemanticAlertMatch(
      env({
        WEBHOOK_DELIVERY_QUEUE: {
          sendBatch: async (messages: Array<{ body: { url: string } }>) => {
            for (const message of messages) urls.push(message.body.url);
          },
        } as unknown as Queue<unknown>,
      }),
      {
        sourceName: "Changelog",
        sourceId: "src_a",
        orgId: "org_a",
        productId: "prd_a",
        releases: [{ id: "rel_a", event: event() }],
      },
      { resolveModel: async () => scoringModel(0.95) },
    );
    expect(urls).toEqual([]);
  });

  it("does not notify when the model cannot be built", async () => {
    await seedUser("u1");
    await seedCatalog();
    await follow("u1", "org", "org_a");
    await alert({ id: "sal_a", userId: "u1" });
    const sent: string[] = [];
    await runSemanticAlertMatch(
      env({
        AUTH_EMAIL: {
          send: async (message) => {
            sent.push(message.to);
            return {};
          },
        },
      }),
      {
        sourceName: "Changelog",
        sourceId: "src_a",
        orgId: "org_a",
        productId: "prd_a",
        releases: [{ id: "rel_a", event: event() }],
      },
      { resolveModel: async () => null },
    );
    expect(sent).toEqual([]);
    expect(await h.db.select().from(semanticAlertMatches)).toEqual([]);
  });
});

function publishHub(): DurableObjectNamespace {
  return {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async () => new Response(JSON.stringify({ published: 1 })),
    }),
  } as unknown as DurableObjectNamespace;
}

describe("publishReleaseEvents semantic alerts", () => {
  it("does not touch the database when the flag is off", async () => {
    const db = {
      select() {
        throw new Error(`db touched ${QUERY}`);
      },
    };
    await publishReleaseEvents(
      {
        RELEASE_HUB: publishHub(),
        SEMANTIC_ALERTS_ENABLED: "false",
        DB: db as unknown as D1Database,
      },
      {
        src: { name: "Changelog", slug: "changelog", orgId: "org_a", sourceId: "src_a" },
        inserted: [{ id: "rel_a", title: "t", version: null, publishedAt: null, media: null }],
      },
    );
  });

  it("fails closed without logging the query when matching throws", async () => {
    const logs: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    const db = {
      select() {
        throw new Error(`db touched ${QUERY}`);
      },
    };
    try {
      await publishReleaseEvents(
        {
          RELEASE_HUB: publishHub(),
          SEMANTIC_ALERTS_ENABLED: "true",
          DB: db as unknown as D1Database,
        },
        {
          src: { name: "Changelog", slug: "changelog", orgId: "org_a", sourceId: "src_a" },
          inserted: [{ id: "rel_a", title: "t", version: null, publishedAt: null, media: null }],
        },
      );
    } finally {
      console.warn = warn;
    }
    const joined = logs.join("\n");
    expect(joined).toContain("semantic-alert-match-failed");
    expect(joined).not.toContain(QUERY);
  });
});

describe("semantic alert analytics points", () => {
  it("records structured fields and not the freeform query", () => {
    const point = encodeSemanticAlertPoint("production", {
      releaseId: "rel_a",
      sourceId: "src_a",
      alertId: "sal_a",
      provider: "openrouter",
      model: "openrouter:typesafe/jev-1.13",
      disposition: "matched",
      probability: 0.91,
      threshold: 0.8,
    });
    const encoded = JSON.stringify(point);
    expect(encoded).not.toContain(QUERY);
    expect(point.blobs[3]).toBe("semantic-alert");
    expect(point.blobs[10]).toBe("sal_a");
    expect(point.doubles[0]).toBe(0.91);
    expect(point.doubles[2]).toBe(0.8);
  });
});
