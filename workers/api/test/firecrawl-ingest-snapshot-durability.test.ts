/**
 * Durability guarantee for FirecrawlIngestWorkflow.
 *
 * A Firecrawl `changed` event carries a hunkless whole-document diff that exists
 * nowhere else — monitors diff against Firecrawl's stored page state, not ours,
 * so once an instance dies the next check diffs against the already-changed page
 * and the delta is gone permanently.
 *
 * That is not hypothetical: when the Anthropic account hit its spend cap on
 * 2026-07-23, extraction failed on every call for six days and the workflow
 * logged 53 `ingest-failed` events across 11 sources with zero successful
 * ingests. Every one of those deltas was unrecoverable because nothing had been
 * written down before extraction ran.
 *
 * These tests pin the fix: the resolved body is snapshotted BEFORE extract, so
 * an extraction outage is replayable via `reextract-source` instead of lossy.
 */

import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { applyMigrations, ensureBatchShim } from "../../../tests/db-helper";
import { organizations, sources, sourceRawSnapshots } from "@buildinternet/releases-core/schema";
import type { RawRelease } from "@releases/adapters/types";
import type { WorkflowStep } from "cloudflare:workers";
import { FirecrawlIngestWorkflow } from "../src/workflows/firecrawl-ingest.js";

const DELTA = "## Acme 2.0\n\nBig new release with real body content.";

function mkDb() {
  const sqlite = new Database(":memory:");
  const db = ensureBatchShim(drizzle(sqlite));
  applyMigrations(sqlite);
  db.insert(organizations)
    .values({ id: "org_fc", slug: "acme", name: "Acme", category: "productivity" })
    .run();
  db.insert(sources)
    .values({
      id: "src_fc",
      orgId: "org_fc",
      slug: "acme-changelog",
      name: "Acme Changelog",
      type: "scrape",
      url: "https://acme.example/changelog",
      metadata: JSON.stringify({ firecrawl: { enabled: true, target: "scrape" } }),
    })
    .run();
  return db;
}

function mkStepSpy() {
  const names: string[] = [];
  const step = {
    do: async (name: string, a: unknown, b?: unknown) => {
      names.push(name);
      const fn = (typeof a === "function" ? a : b) as () => Promise<unknown>;
      return await fn();
    },
    sleep: async () => {},
  } as unknown as WorkflowStep;
  return { names, step };
}

/** Minimal in-memory stand-in for the RAW_SNAPSHOTS R2 bucket. */
function mkBucket() {
  const objects = new Map<string, string>();
  return {
    objects,
    bucket: {
      put: async (key: string, value: string) => {
        objects.set(key, value);
      },
      get: async (key: string) =>
        objects.has(key) ? { text: async () => objects.get(key) as string } : null,
      head: async (key: string) => (objects.has(key) ? {} : null),
    },
  };
}

const ONE_RELEASE: RawRelease[] = [
  {
    title: "Acme 2.0",
    content: "Big new release with real body content.",
    url: "https://acme.example/changelog/acme-2-0",
    publishedAt: new Date("2026-05-18T10:00:00Z"),
    isBreaking: false,
    media: [],
  },
];

function runWorkflow(
  db: ReturnType<typeof mkDb>,
  bucket: unknown,
  extract: () => Promise<RawRelease[]>,
  step: WorkflowStep,
) {
  const env = {
    DB: {} as unknown,
    _drizzleOverride: db,
    _extractOverride: extract,
    RAW_SNAPSHOTS: bucket,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wf = new (FirecrawlIngestWorkflow as any)({}, env);
  return wf.run(
    {
      payload: {
        sourceId: "src_fc",
        url: "https://acme.example/changelog",
        checkId: "chk_1",
        status: "changed",
        delta: DELTA,
      },
    },
    step,
  );
}

describe("FirecrawlIngestWorkflow — pre-extract snapshot durability", () => {
  it("captures the snapshot before extraction runs", async () => {
    const db = mkDb();
    const { objects, bucket } = mkBucket();
    const { names, step } = mkStepSpy();

    await runWorkflow(db, bucket, async () => ONE_RELEASE, step);

    const capture = names.indexOf("capture-snapshot");
    const extract = names.indexOf("extract");
    expect(capture).toBeGreaterThanOrEqual(0);
    expect(extract).toBeGreaterThanOrEqual(0);
    // Ordering is the entire guarantee — after extract would be useless.
    expect(capture).toBeLessThan(extract);

    // The body itself is in the bucket, byte-for-byte.
    expect([...objects.values()]).toContain(DELTA);
  });

  it("still persists the delta when extraction fails outright (the 2026-07-23 case)", async () => {
    const db = mkDb();
    const { objects, bucket } = mkBucket();
    const { step } = mkStepSpy();

    // Mirrors the spend-cap error that took extraction down for six days.
    const boom = async () => {
      throw new Error("You have reached your specified API usage limits.");
    };

    // The workflow re-throws so CF marks the instance failed — that part is
    // unchanged. What matters is what survives the failure.
    let thrown: unknown;
    try {
      await runWorkflow(db, bucket, boom, step);
    } catch (err) {
      thrown = err;
    }
    expect(String((thrown as Error)?.message)).toMatch(/usage limits/);

    const rows = db
      .select()
      .from(sourceRawSnapshots)
      .where(eq(sourceRawSnapshots.sourceId, "src_fc"))
      .all();

    expect(rows.length).toBe(1);
    expect(rows[0]?.format).toBe("markdown");
    // Recoverable: the pointer row and the object agree, so reextract-source
    // can replay this exact body without a live scrape.
    expect(objects.get(rows[0]!.r2Key as string)).toBe(DELTA);
  });

  // The replay route takes `snapshotId`, so a failure log carrying only the
  // r2Key is not actionable — an operator cannot invoke reextract-source from it.
  it("returns the snapshot row id so the failure is replayable", async () => {
    const db = mkDb();
    const { bucket } = mkBucket();
    const { step } = mkStepSpy();

    await runWorkflow(db, bucket, async () => ONE_RELEASE, step);

    const rows = db
      .select()
      .from(sourceRawSnapshots)
      .where(eq(sourceRawSnapshots.sourceId, "src_fc"))
      .all();
    expect(rows.length).toBe(1);
    expect(rows[0]?.id).toBeTruthy();
  });

  // A spend cap fails identically on every attempt, so burning the retry budget
  // is pure waste against a provider that has already cut us off. The first
  // version classified only after RETRY_FETCH had exhausted.
  it("raises a quota shutoff as non-retryable rather than letting it retry", async () => {
    const db = mkDb();
    const { bucket } = mkBucket();
    const { step } = mkStepSpy();

    let attempts = 0;
    const capped = async () => {
      attempts += 1;
      throw new Error(
        "You have reached your specified API usage limits. You will regain access on 2026-08-01 at 00:00 UTC.",
      );
    };

    let thrown: unknown;
    try {
      await runWorkflow(db, bucket, capped, step);
    } catch (err) {
      thrown = err;
    }

    expect(attempts).toBe(1);
    // NonRetryableError is what tells the Workflows runtime to stop.
    expect((thrown as Error)?.name).toMatch(/NonRetryable/);
  });

  it("does not fail the ingest when RAW_SNAPSHOTS is unbound", async () => {
    const db = mkDb();
    const { names, step } = mkStepSpy();

    // Snapshotting is best-effort; an unbound bucket degrades to the old
    // behavior rather than breaking an otherwise-healthy ingest.
    await runWorkflow(db, undefined, async () => ONE_RELEASE, step);

    expect(names).toContain("capture-snapshot");
    expect(names).toContain("dedup-insert");
  });
});
