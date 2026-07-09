import { describe, expect, it } from "bun:test";
import {
  assembleActivityBuckets,
  buildActivityCacheKey,
  buildEmptyActivityBucket,
  fillActivityBuckets,
  floorToBucket,
  parseExcludeStatuses,
  resolveActivityWindow,
  MAX_ACTIVITY_BUCKETS,
} from "../../workers/api/src/routes/fetch-activity";

describe("floorToBucket", () => {
  it("floors to hour UTC", () => {
    expect(floorToBucket("2026-07-09T14:37:12.456Z", "hour")).toBe("2026-07-09T14:00:00.000Z");
  });

  it("floors to day UTC", () => {
    expect(floorToBucket("2026-07-09T14:37:12.456Z", "day")).toBe("2026-07-09T00:00:00.000Z");
  });
});

describe("resolveActivityWindow", () => {
  const nowMs = Date.parse("2026-07-09T12:00:00.000Z");

  it("defaults after to 30d lookback when omitted", () => {
    const w = resolveActivityWindow({ after: null, before: null, bucket: "day", nowMs });
    expect(w.before).toBe("2026-07-09T12:00:00.000Z");
    expect(w.after).toBe("2026-06-09T12:00:00.000Z");
    expect(w.bucket).toBe("day");
  });

  it("coerces hour → day when the span would exceed the bucket cap", () => {
    const w = resolveActivityWindow({
      after: "2025-01-01T00:00:00.000Z",
      before: "2026-07-09T00:00:00.000Z",
      bucket: "hour",
      nowMs,
    });
    expect(w.bucket).toBe("day");
  });

  it("swaps inverted bounds", () => {
    const w = resolveActivityWindow({
      after: "2026-07-09T00:00:00.000Z",
      before: "2026-07-01T00:00:00.000Z",
      bucket: "day",
      nowMs,
    });
    expect(Date.parse(w.after)).toBeLessThan(Date.parse(w.before));
  });

  it("clamps an oversized day range to MAX_ACTIVITY_BUCKETS", () => {
    const w = resolveActivityWindow({
      after: "2020-01-01T00:00:00.000Z",
      before: "2026-07-09T00:00:00.000Z",
      bucket: "day",
      nowMs,
    });
    const days = Math.floor((Date.parse(w.before) - Date.parse(w.after)) / 86_400_000) + 1;
    expect(days).toBeLessThanOrEqual(MAX_ACTIVITY_BUCKETS);
  });
});

describe("fillActivityBuckets", () => {
  it("emits continuous zeros and overlays populated counts", () => {
    const populated = new Map([
      [
        "2026-07-09T10:00:00.000Z",
        {
          ...buildEmptyActivityBucket("2026-07-09T10:00:00.000Z"),
          success: 3,
          total: 3,
          releasesInserted: 2,
        },
      ],
    ]);
    const buckets = fillActivityBuckets(
      "2026-07-09T09:15:00.000Z",
      "2026-07-09T11:30:00.000Z",
      "hour",
      populated,
    );
    expect(buckets.map((b) => b.t)).toEqual([
      "2026-07-09T09:00:00.000Z",
      "2026-07-09T10:00:00.000Z",
      "2026-07-09T11:00:00.000Z",
    ]);
    expect(buckets[0]!.success).toBe(0);
    expect(buckets[1]!.success).toBe(3);
    expect(buckets[1]!.releasesInserted).toBe(2);
    expect(buckets[2]!.total).toBe(0);
  });
});

describe("parseExcludeStatuses", () => {
  it("parses a comma list and drops unknowns", () => {
    expect(parseExcludeStatuses("no_change,bogus,error")).toEqual(["no_change", "error"]);
  });

  it("returns empty for missing input", () => {
    expect(parseExcludeStatuses(undefined)).toEqual([]);
    expect(parseExcludeStatuses("")).toEqual([]);
  });
});

describe("buildActivityCacheKey", () => {
  it("floors bounds and includes org", () => {
    const key = buildActivityCacheKey({
      bucket: "hour",
      after: "2026-07-09T14:37:00.000Z",
      before: "2026-07-09T15:12:00.000Z",
      org: "acme",
    });
    expect(key).toBe(
      "fetch-activity:v1:hour:2026-07-09T14:00:00.000Z:2026-07-09T15:00:00.000Z:acme",
    );
  });
});

describe("assembleActivityBuckets", () => {
  it("merges status + org rows and fills gaps", () => {
    const buckets = assembleActivityBuckets({
      after: "2026-04-01T10:00:00.000Z",
      before: "2026-04-01T11:30:00.000Z",
      bucket: "hour",
      statusRows: [
        { bucket: "2026-04-01T10:00:00.000Z", status: "success", n: 2, inserts: 3 },
        { bucket: "2026-04-01T10:00:00.000Z", status: "no_change", n: 5, inserts: 0 },
      ],
      orgRows: [
        {
          bucket: "2026-04-01T10:00:00.000Z",
          orgSlug: "acme",
          orgName: "Acme",
          avatarUrl: null,
          n: 2,
        },
      ],
    });
    expect(buckets).toHaveLength(2);
    expect(buckets[0]!.success).toBe(2);
    expect(buckets[0]!.no_change).toBe(5);
    expect(buckets[0]!.total).toBe(7);
    expect(buckets[0]!.releasesInserted).toBe(3);
    expect(buckets[0]!.topOrgs.map((o) => o.slug)).toEqual(["acme"]);
    expect(buckets[1]!.total).toBe(0);
  });
});
