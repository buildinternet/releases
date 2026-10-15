/**
 * POST /v1/admin/marketing-classifier/reclassify — re-run the marketing
 * classifier on rows that are already stored.
 *
 * The model call goes through the real `resolveMarketingModel` → Anthropic
 * seam. `globalThis.fetch` is the only fake, restored after every test.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { organizations, releases, sources } from "@buildinternet/releases-core/schema";
import { createTestDb, type TestDatabase } from "../../../../tests/db-helper.js";
import { mockGlobalFetch, restoreGlobalFetch } from "../../../../tests/global-fetch.js";
import { adminMarketingClassifierRoutes } from "./admin-marketing-classifier.js";
import { clearMarketingThresholdCache } from "../lib/classification/marketing-classifier-settings.js";
import type { ClassificationDataPoint } from "../lib/classification/classification-schema.js";

let h: TestDatabase;
const points: ClassificationDataPoint[] = [];

function secretBinding(value: string) {
  return { get: async () => value };
}

function app(extra: Record<string, unknown> = {}) {
  const a = new Hono();
  a.route("/", adminMarketingClassifierRoutes);
  const env = {
    DB: h.db,
    RELEASES_API_KEY: secretBinding("root-secret"),
    ANTHROPIC_API_KEY: secretBinding("test-anthropic-key"),
    ENVIRONMENT: "production",
    RELEASE_CLASSIFICATIONS_AE: {
      writeDataPoint(point: ClassificationDataPoint) {
        points.push(point);
      },
    },
    ...extra,
  };
  return { a, env };
}

const BASE = "https://api.releases.sh";
const auth = { Authorization: "Bearer root-secret", "content-type": "application/json" };

function anthropicText(text: string, status = 200): Response {
  return new Response(
    JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-haiku-5-5",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 20,
        output_tokens: 8,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

/** Marketing when the prompt mentions "Case study", otherwise product news. */
async function requestText(input: RequestInfo | URL, init?: RequestInit): Promise<string> {
  if (typeof init?.body === "string") return init.body;
  if (init?.body instanceof Uint8Array) return new TextDecoder().decode(init.body);
  if (input instanceof Request) return input.clone().text();
  return "";
}

function installClassifier() {
  mockGlobalFetch((async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = await requestText(input, init);
    const marketing = raw.includes("Case study");
    const text = marketing
      ? "<marketing>true</marketing><reason>case_study</reason>"
      : "<marketing>false</marketing>";
    return anthropicText(text);
  }) as unknown as typeof fetch);
}

async function seedRelease(opts: {
  id: string;
  title: string;
  content?: string;
  suppressed?: boolean;
  suppressedReason?: string | null;
  sourceId?: string;
}) {
  await h.db.insert(releases).values({
    id: opts.id,
    sourceId: opts.sourceId ?? "src_1",
    title: opts.title,
    content: opts.content ?? "A product change with enough detail to classify.",
    url: `https://acme.example.com/${opts.id}`,
    suppressed: opts.suppressed ?? false,
    suppressedReason: opts.suppressedReason ?? null,
  });
}

async function stored(id: string) {
  const [row] = await h.db.select().from(releases).where(eq(releases.id, id));
  return row;
}

function post(body: unknown, extra?: Record<string, unknown>) {
  const { a, env } = app(extra);
  return a.request(
    `${BASE}/admin/marketing-classifier/reclassify`,
    { method: "POST", headers: auth, body: JSON.stringify(body) },
    env,
  );
}

beforeEach(async () => {
  h = createTestDb();
  points.length = 0;
  clearMarketingThresholdCache();
  await h.db.insert(organizations).values({ id: "org_1", name: "Acme", slug: "acme" });
  await h.db.insert(sources).values({
    id: "src_1",
    orgId: "org_1",
    name: "Acme Blog",
    slug: "acme-blog",
    type: "scrape",
    url: "https://acme.example.com/blog",
    metadata: JSON.stringify({ marketingFilterHint: "Watch for customer stories" }),
  });
});

afterEach(() => {
  restoreGlobalFetch();
  clearMarketingThresholdCache();
  h.cleanup?.();
});

describe("POST /admin/marketing-classifier/reclassify", () => {
  it("403s without admin auth", async () => {
    const { a, env } = app();
    const res = await a.request(
      `${BASE}/admin/marketing-classifier/reclassify`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ releaseId: "rel_1" }),
      },
      env,
    );
    expect(res.status).toBe(403);
  });

  it("400s unless exactly one selector is set", async () => {
    const neither = await post({});
    expect(neither.status).toBe(400);
    const both = await post({ releaseId: "rel_1", sourceId: "src_1" });
    expect(both.status).toBe(400);
    const paging = await post({ releaseId: "rel_1", limit: 5 });
    expect(paging.status).toBe(400);
  });

  it("previews a marketing verdict without writing when dryRun is omitted", async () => {
    installClassifier();
    await seedRelease({ id: "rel_1", title: "Case study: Acme at scale" });
    const res = await post({ releaseId: "rel_1" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      dryRun: boolean;
      suppressed: number;
      results: Array<{ disposition: string; applied: boolean; suppressedReason: string }>;
    };
    expect(body.dryRun).toBe(true);
    expect(body.suppressed).toBe(1);
    expect(body.results[0]).toMatchObject({
      disposition: "suppressed",
      applied: false,
      suppressedReason: "marketing_classifier:case_study",
    });
    const row = await stored("rel_1");
    expect(row?.suppressed).toBeFalsy();
    expect(row?.suppressedReason).toBeNull();
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(points[0]?.blobs[2]).toBe("manual");
    expect(points[0]?.blobs[9]).toBe("suppressed");
  });

  it("writes a marketing suppression and clears only a classifier reason", async () => {
    installClassifier();
    await seedRelease({ id: "rel_mkt", title: "Case study: Acme at scale" });
    await seedRelease({
      id: "rel_clear",
      title: "Query planner is faster",
      suppressed: true,
      suppressedReason: "marketing_classifier:newsletter",
    });
    await seedRelease({
      id: "rel_hold",
      title: "Manual hold stays",
      suppressed: true,
      suppressedReason: "manual",
    });
    await seedRelease({
      id: "rel_force",
      title: "Refetch hold stays",
      suppressed: true,
      suppressedReason: "force_refetch",
    });

    const res = await post({
      releaseIds: ["rel_mkt", "rel_clear", "rel_hold", "rel_force", "rel_missing"],
      dryRun: false,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      dryRun: boolean;
      suppressed: number;
      kept: number;
      held: number;
      missing: string[];
      results: Array<{ id: string; disposition: string; applied: boolean }>;
    };
    expect(body.dryRun).toBe(false);
    expect(body.missing).toEqual(["rel_missing"]);
    expect(body.suppressed).toBe(1);
    expect(body.kept).toBe(1);
    expect(body.held).toBe(2);
    expect(body.results.map((row) => [row.id, row.disposition, row.applied])).toEqual([
      ["rel_mkt", "suppressed", true],
      ["rel_clear", "kept", true],
      ["rel_hold", "held", false],
      ["rel_force", "held", false],
    ]);

    const mkt = await stored("rel_mkt");
    expect(mkt?.suppressed).toBe(true);
    expect(mkt?.suppressedReason).toBe("marketing_classifier:case_study");
    const cleared = await stored("rel_clear");
    expect(cleared?.suppressed).toBeFalsy();
    expect(cleared?.suppressedReason).toBeNull();
    const held = await stored("rel_hold");
    expect(held?.suppressed).toBe(true);
    expect(held?.suppressedReason).toBe("manual");
    const forced = await stored("rel_force");
    expect(forced?.suppressedReason).toBe("force_refetch");
    expect(
      points.some((point) => point.blobs[9] === "skipped" && point.blobs[12] === "manual_hold"),
    ).toBe(true);
  });

  it("404s a single unknown release and an unknown source", async () => {
    installClassifier();
    const missingRelease = await post({ releaseId: "rel_nope" });
    expect(missingRelease.status).toBe(404);
    const missingSource = await post({ sourceId: "src_nope", dryRun: false });
    expect(missingSource.status).toBe(404);
    expect(points).toHaveLength(0);
  });

  it("pages a source with nextAfter and does not require marketingFilter", async () => {
    installClassifier();
    await seedRelease({ id: "rel_a", title: "Case study A" });
    await seedRelease({ id: "rel_b", title: "Case study B" });
    await seedRelease({ id: "rel_c", title: "Case study C" });

    const first = await post({ sourceId: "src_1", limit: 2, dryRun: false });
    expect(first.status).toBe(200);
    const page = (await first.json()) as {
      nextAfter: string | null;
      results: Array<{ id: string; applied: boolean }>;
    };
    expect(page.results.map((row) => row.id)).toEqual(["rel_a", "rel_b"]);
    expect(page.results.every((row) => row.applied)).toBe(true);
    expect(page.nextAfter).toBe("rel_b");

    const second = await post({
      sourceId: "src_1",
      limit: 2,
      after: page.nextAfter,
      dryRun: false,
    });
    const rest = (await second.json()) as {
      nextAfter: string | null;
      results: Array<{ id: string }>;
    };
    expect(rest.results.map((row) => row.id)).toEqual(["rel_c"]);
    expect(rest.nextAfter).toBeNull();
    expect((await stored("rel_c"))?.suppressedReason).toBe("marketing_classifier:case_study");
  });

  it("503s and writes nothing when no model is configured", async () => {
    await seedRelease({ id: "rel_1", title: "Case study: Acme at scale" });
    const res = await post({ releaseId: "rel_1", dryRun: false }, { ANTHROPIC_API_KEY: undefined });
    expect(res.status).toBe(503);
    const row = await stored("rel_1");
    expect(row?.suppressed).toBeFalsy();
    expect(points).toHaveLength(0);
  });

  it("leaves the row unchanged when classification fails", async () => {
    mockGlobalFetch((async () => anthropicText("nope", 500)) as unknown as typeof fetch);
    await seedRelease({
      id: "rel_1",
      title: "Case study: Acme at scale",
      suppressed: true,
      suppressedReason: "marketing_classifier:newsletter",
    });
    const res = await post({ releaseId: "rel_1", dryRun: false });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { failed: number; results: Array<{ disposition: string }> };
    expect(body.failed).toBe(1);
    expect(body.results[0]?.disposition).toBe("failed");
    const row = await stored("rel_1");
    expect(row?.suppressed).toBe(true);
    expect(row?.suppressedReason).toBe("marketing_classifier:newsletter");
  });
});
