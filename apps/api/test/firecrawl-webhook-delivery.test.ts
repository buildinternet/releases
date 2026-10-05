/**
 * Delivery-health bookkeeping on the Firecrawl receiver: auth rejections are
 * logged (never the token) and leave a throttled KV marker, and every
 * authenticated delivery — including cost-gate skips — stamps
 * `metadata.firecrawl.lastDeliveryAt` for the staleness scan.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { eq } from "drizzle-orm";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import { createTestApp, createTestDb } from "./setup";
import { firecrawlRoutes } from "../src/routes/firecrawl";
import {
  readFirecrawlAuthRejection,
  recordFirecrawlAuthRejection,
} from "../src/lib/ingest/firecrawl-delivery";

const WEBHOOK_PATH = "/v1/inbound/firecrawl";
/** Fixture only — not a deployed secret. */
const TOKEN = "fc-test-token";

function memoryKv() {
  const store = new Map<string, string>();
  let puts = 0;
  return {
    store,
    get puts() {
      return puts;
    },
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => {
      puts++;
      store.set(k, v);
    },
  };
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://api${WEBHOOK_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

let logs: string[] = [];
let spies: Array<{ mockRestore(): void }> = [];
beforeEach(() => {
  logs = [];
  const capture = (line: unknown) => {
    logs.push(String(line));
  };
  spies = [
    spyOn(console, "warn").mockImplementation(capture),
    spyOn(console, "error").mockImplementation(capture),
    spyOn(console, "log").mockImplementation(capture),
  ];
});
afterEach(() => {
  for (const s of spies) s.mockRestore();
});

const events = () =>
  logs.flatMap((l) => {
    try {
      return [JSON.parse(l) as Record<string, unknown>];
    } catch {
      return [];
    }
  });

describe("Firecrawl receiver — auth rejections", () => {
  it("logs the reason without the token and records a KV marker", async () => {
    const kv = memoryKv();
    const call = createTestApp(createTestDb(), firecrawlRoutes, {
      env: { FIRECRAWL_WEBHOOK_SECRET: { get: async () => TOKEN }, LATEST_CACHE: kv },
    });

    const wrong = await call(post({}, { "X-Firecrawl-Token": "not-it" }));
    expect(wrong.status).toBe(401);
    const missing = await call(post({}));
    expect(missing.status).toBe(401);

    const rejected = events().filter((e) => e.event === "auth-rejected");
    expect(rejected.map((e) => e.reason)).toEqual(["mismatch", "missing"]);
    expect(logs.join("\n")).not.toContain("not-it");

    const marker = await readFirecrawlAuthRejection(kv as never);
    expect(marker?.reason).toBe("missing");
  });

  it("reports an unbound secret as its own reason", async () => {
    const call = createTestApp(createTestDb(), firecrawlRoutes, {
      env: { FIRECRAWL_WEBHOOK_SECRET: { get: async () => "" } },
    });
    const res = await call(post({}, { "X-Firecrawl-Token": TOKEN }));
    expect(res.status).toBe(401);
    expect(events().find((e) => e.event === "auth-rejected")?.reason).toBe("secret-unbound");
  });

  it("throttles marker writes and keeps the streak start", async () => {
    const kv = memoryKv();
    const t0 = new Date("2026-09-15T00:00:00.000Z");
    await recordFirecrawlAuthRejection(kv as never, "mismatch", t0);
    // A batch of ~40 deliveries in the same minutes → one write.
    for (let i = 1; i <= 40; i++) {
      await recordFirecrawlAuthRejection(
        kv as never,
        "mismatch",
        new Date(t0.getTime() + i * 1000),
      );
    }
    expect(kv.puts).toBe(1);

    const nextDay = new Date("2026-09-16T00:00:00.000Z");
    await recordFirecrawlAuthRejection(kv as never, "mismatch", nextDay);
    expect(kv.puts).toBe(2);
    const marker = await readFirecrawlAuthRejection(kv as never);
    expect(marker).toEqual({
      firstAt: t0.toISOString(),
      lastAt: nextDay.toISOString(),
      reason: "mismatch",
    });
  });
});

describe("Firecrawl receiver — delivery stamp", () => {
  it("stamps lastDeliveryAt on a gate-skipped delivery without touching other metadata", async () => {
    const db = createTestDb();
    await db.insert(organizations).values({ id: "org_a", slug: "acme", name: "Acme" });
    await db.insert(sources).values({
      id: "src_fc",
      orgId: "org_a",
      name: "Changelog",
      slug: "changelog",
      type: "scrape",
      url: "https://acme.example.com/changelog",
      metadata: JSON.stringify({
        firecrawl: { enabled: true, monitorId: "mon_1", lastCheckId: "chk_0" },
        feedUrl: "https://acme.example.com/feed.xml",
      }),
      lastFetchedAt: "2026-09-01T00:00:00.000Z",
    });
    const call = createTestApp(db, firecrawlRoutes, {
      env: { FIRECRAWL_WEBHOOK_SECRET: { get: async () => TOKEN } },
    });

    const res = await call(
      post(
        {
          type: "monitor.page",
          metadata: { sourceId: "src_fc" },
          data: [{ checkId: "chk_1", url: "https://acme.example.com/changelog", status: "same" }],
        },
        { "X-Firecrawl-Token": TOKEN },
      ),
    );
    expect(res.status).toBe(200);
    expect(events().some((e) => e.event === "gate-skip")).toBe(true);

    const [row] = await db.select().from(sources).where(eq(sources.id, "src_fc"));
    const meta = JSON.parse(row.metadata ?? "{}");
    expect(typeof meta.firecrawl.lastDeliveryAt).toBe("string");
    expect(Date.now() - Date.parse(meta.firecrawl.lastDeliveryAt)).toBeLessThan(60_000);
    expect(meta.firecrawl.monitorId).toBe("mon_1");
    expect(meta.firecrawl.lastCheckId).toBe("chk_0");
    expect(meta.feedUrl).toBe("https://acme.example.com/feed.xml");
    // The ingest clock only moves when the workflow ingests.
    expect(row.lastFetchedAt).toBe("2026-09-01T00:00:00.000Z");
  });
});
