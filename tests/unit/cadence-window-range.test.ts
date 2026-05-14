import { describe, expect, it } from "bun:test";
import { pickWindowVersionRange, type WeeklyBucket } from "../../web/src/lib/cadence";

function bucket(weekStart: string, earliest: string | null, latest: string | null): WeeklyBucket {
  return {
    weekStart: new Date(weekStart),
    count: 1,
    earliestVersion: earliest,
    latestVersion: latest,
  };
}

describe("pickWindowVersionRange", () => {
  it("returns nulls for an empty window", () => {
    expect(pickWindowVersionRange([])).toEqual({ earliest: null, latest: null });
  });

  it("picks semver-max even when a backport is the last bucket (the bug repro)", () => {
    const buckets = [
      bucket("2026-04-01", "16.1.0", "16.1.7"),
      bucket("2026-04-15", "16.2.0", "16.2.4"),
      bucket("2026-05-07", "15.5.18", "15.5.18"), // backport, last in time order
    ];
    const range = pickWindowVersionRange(buckets);
    expect(range.latest).toBe("16.2.4");
    expect(range.earliest).toBe("15.5.18");
  });

  it("falls back to last-bucket value for purely non-semver sources", () => {
    const buckets = [
      bucket("2026-04-01", "jaguar", "jaguar"),
      bucket("2026-04-15", "fossa", "fossa"),
    ];
    const range = pickWindowVersionRange(buckets);
    expect(range.latest).toBe("fossa");
    expect(range.earliest).toBe("jaguar");
  });

  it("prefers any semver pick over a non-semver bucket", () => {
    const buckets = [
      bucket("2026-04-01", "codename", "codename"),
      bucket("2026-04-15", "1.0.0", "1.2.3"),
    ];
    const range = pickWindowVersionRange(buckets);
    expect(range.latest).toBe("1.2.3");
    expect(range.earliest).toBe("1.0.0");
  });

  it("skips buckets with no version", () => {
    const buckets = [
      bucket("2026-04-01", null, null),
      bucket("2026-04-15", "2.0.0", "2.1.0"),
      bucket("2026-04-22", null, null),
    ];
    const range = pickWindowVersionRange(buckets);
    expect(range.latest).toBe("2.1.0");
    expect(range.earliest).toBe("2.0.0");
  });
});
