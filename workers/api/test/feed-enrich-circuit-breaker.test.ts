/**
 * Circuit-breaker tests for feed enrichment.
 *
 * After ENRICH_CONSECUTIVE_FAILURE_LIMIT consecutive failed enrichment
 * attempts on a source, `enrichNewThinItems` must skip the source entirely
 * (no calls to `enrichFn`) and return an empty map. The counter is stored in
 * `source.metadata.enrichment.consecutiveFailures`. A success resets it.
 *
 * These tests use the pure helper functions exported from feed-enrich:
 * - `isEnrichmentCircuitOpen` — reads the counter from SourceMetadata and
 *   returns true when the breaker has tripped.
 * - `nextEnrichmentMetadata` — derives the next metadata enrichment block
 *   (increment on failure, reset to 0 on success).
 * - `ENRICH_CONSECUTIVE_FAILURE_LIMIT` — named constant.
 */
import { describe, it, expect } from "bun:test";
import {
  isEnrichmentCircuitOpen,
  nextEnrichmentMetadata,
  ENRICH_CONSECUTIVE_FAILURE_LIMIT,
} from "../src/cron/feed-enrich.js";
import type { SourceMetadata } from "@releases/adapters/source-meta";

describe("ENRICH_CONSECUTIVE_FAILURE_LIMIT", () => {
  it("is a positive integer", () => {
    expect(ENRICH_CONSECUTIVE_FAILURE_LIMIT).toBeGreaterThan(0);
    expect(Number.isInteger(ENRICH_CONSECUTIVE_FAILURE_LIMIT)).toBe(true);
  });
});

describe("isEnrichmentCircuitOpen", () => {
  it("returns false when no enrichment metadata is present", () => {
    const meta: SourceMetadata = {};
    expect(isEnrichmentCircuitOpen(meta)).toBe(false);
  });

  it("returns false when consecutiveFailures is below the limit", () => {
    const meta: SourceMetadata = {
      enrichment: { consecutiveFailures: ENRICH_CONSECUTIVE_FAILURE_LIMIT - 1 },
    };
    expect(isEnrichmentCircuitOpen(meta)).toBe(false);
  });

  it("returns true when consecutiveFailures equals the limit", () => {
    const meta: SourceMetadata = {
      enrichment: { consecutiveFailures: ENRICH_CONSECUTIVE_FAILURE_LIMIT },
    };
    expect(isEnrichmentCircuitOpen(meta)).toBe(true);
  });

  it("returns true when consecutiveFailures exceeds the limit", () => {
    const meta: SourceMetadata = {
      enrichment: { consecutiveFailures: ENRICH_CONSECUTIVE_FAILURE_LIMIT + 5 },
    };
    expect(isEnrichmentCircuitOpen(meta)).toBe(true);
  });

  it("returns false when consecutiveFailures is 0 (reset after a success)", () => {
    const meta: SourceMetadata = {
      enrichment: { consecutiveFailures: 0 },
    };
    expect(isEnrichmentCircuitOpen(meta)).toBe(false);
  });
});

describe("nextEnrichmentMetadata", () => {
  it("starts count at 1 on the first failure when there is no prior enrichment block", () => {
    const next = nextEnrichmentMetadata(undefined, false);
    expect(next.consecutiveFailures).toBe(1);
  });

  it("increments consecutiveFailures on a failure", () => {
    const next = nextEnrichmentMetadata({ consecutiveFailures: 2 }, false);
    expect(next.consecutiveFailures).toBe(3);
  });

  it("resets consecutiveFailures to 0 on a success", () => {
    const next = nextEnrichmentMetadata({ consecutiveFailures: 5 }, true);
    expect(next.consecutiveFailures).toBe(0);
  });

  it("resets from undefined to 0 on the first success", () => {
    const next = nextEnrichmentMetadata(undefined, true);
    expect(next.consecutiveFailures).toBe(0);
  });

  it("preserves consecutiveFailures at 0 on repeated successes", () => {
    const next = nextEnrichmentMetadata({ consecutiveFailures: 0 }, true);
    expect(next.consecutiveFailures).toBe(0);
  });
});
