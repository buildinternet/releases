import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { organizations, products, sources } from "@buildinternet/releases-core/schema";
import type { NoulBatchModel, NoulBatchRequest } from "@releases/ai-internal/decision-model";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import { user } from "../src/db/schema-auth.js";
import { userFollows } from "../src/db/schema-follows.js";
import { semanticAlerts } from "../src/db/schema-semantic-alerts.js";
import { matchSemanticAlertsForUser } from "../src/semantic-alerts/semantic-alert-matcher.js";

const QUERY = "Slack integrations with B2B software";

let h: TestDatabase;

beforeEach(() => {
  h = createTestDb();
});

afterEach(() => h.cleanup());

async function seed() {
  await h.db.insert(user).values({
    id: "u1",
    name: "u1",
    email: "u1@example.com",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await h.db.insert(organizations).values({ id: "org_a", name: "Acme", slug: "acme" });
  await h.db.insert(products).values({
    id: "prd_a",
    name: "App",
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
}

function scoringModel(probability: number, calls: NoulBatchRequest[] = []): NoulBatchModel {
  return {
    id: "openrouter:typesafe/jev-1.13",
    decideNoul: async (request) => {
      calls.push(request);
      return {
        answers: request.questions.map((question) => ({ id: question.id, probability })),
        usage: { inputTokens: 5, outputTokens: 1 },
      };
    },
  };
}

describe("matchSemanticAlertsForUser", () => {
  it("scores follows-eligible alerts and skips non-followers", async () => {
    await seed();
    await h.db.insert(userFollows).values({
      id: "uf_1",
      userId: "u1",
      targetType: "org",
      targetId: "org_a",
      createdAt: new Date(),
    });
    const now = new Date();
    await h.db.insert(semanticAlerts).values({
      id: "sal_a",
      userId: "u1",
      query: QUERY,
      enabled: true,
      threshold: 0.8,
      deliverEmail: true,
      deliverWebhook: false,
      webhookSubscriptionId: null,
      createdAt: now,
      updatedAt: now,
    });
    const calls: NoulBatchRequest[] = [];
    const result = await matchSemanticAlertsForUser(
      h.db as never,
      "u1",
      [
        {
          id: "rel_a",
          title: "Slack for finance teams",
          content: "Connect Slack to approvals",
          sourceId: "src_a",
          orgId: "org_a",
        },
      ],
      {},
      { resolveModel: async () => scoringModel(0.91, calls) },
    );
    expect(result.status).toBe("scored");
    expect(result.matches).toEqual([
      {
        alertId: "sal_a",
        releaseId: "rel_a",
        probability: 0.91,
        matched: true,
        threshold: 0.8,
      },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.state).not.toContain(QUERY);
    expect(calls[0]!.questions[0]!.criteria.true).toBe(QUERY);
  });

  it("returns scored with no matches when the user does not follow the release", async () => {
    await seed();
    const now = new Date();
    await h.db.insert(semanticAlerts).values({
      id: "sal_a",
      userId: "u1",
      query: QUERY,
      enabled: true,
      threshold: 0.8,
      deliverEmail: true,
      deliverWebhook: false,
      webhookSubscriptionId: null,
      createdAt: now,
      updatedAt: now,
    });
    let called = false;
    const result = await matchSemanticAlertsForUser(
      h.db as never,
      "u1",
      [
        {
          id: "rel_a",
          title: "Slack for finance teams",
          content: "Connect Slack",
          sourceId: "src_a",
          orgId: "org_a",
        },
      ],
      {},
      {
        resolveModel: async () => {
          called = true;
          return scoringModel(0.99);
        },
      },
    );
    expect(result).toEqual({ status: "scored", matches: [] });
    expect(called).toBe(false);
  });

  it("returns model_unavailable when the decision model cannot be built", async () => {
    await seed();
    await h.db.insert(userFollows).values({
      id: "uf_1",
      userId: "u1",
      targetType: "org",
      targetId: "org_a",
      createdAt: new Date(),
    });
    const now = new Date();
    await h.db.insert(semanticAlerts).values({
      id: "sal_a",
      userId: "u1",
      query: QUERY,
      enabled: true,
      threshold: 0.8,
      deliverEmail: true,
      deliverWebhook: false,
      webhookSubscriptionId: null,
      createdAt: now,
      updatedAt: now,
    });
    const result = await matchSemanticAlertsForUser(
      h.db as never,
      "u1",
      [
        {
          id: "rel_a",
          title: "Slack for finance teams",
          content: "Connect Slack",
          sourceId: "src_a",
          orgId: "org_a",
        },
      ],
      {},
      { resolveModel: async () => null },
    );
    expect(result).toEqual({
      status: "unavailable",
      reason: "model_unavailable",
      matches: [],
    });
  });
});
