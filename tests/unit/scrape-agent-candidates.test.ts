import { describe, it, expect } from "bun:test";
import { groupByOrg, type Candidate } from "../../workers/api/src/cron/scrape-agent-sweep";

const c = (overrides: Partial<Candidate>): Candidate => ({
  id: "src_1",
  slug: "s-1",
  orgId: "org_a",
  orgSlug: "a",
  orgName: "Org A",
  changeDetectedAt: "2026-04-18T00:00:00Z",
  ...overrides,
});

describe("groupByOrg", () => {
  it("returns an empty map for empty input", () => {
    expect(groupByOrg([])).toEqual(new Map());
  });

  it("groups sources by orgId preserving input order within each group", () => {
    const rows = [
      c({ id: "src_1", orgId: "org_a", changeDetectedAt: "2026-04-18T00:00:00Z" }),
      c({ id: "src_2", orgId: "org_b", changeDetectedAt: "2026-04-18T00:01:00Z" }),
      c({ id: "src_3", orgId: "org_a", changeDetectedAt: "2026-04-18T00:02:00Z" }),
    ];
    const out = groupByOrg(rows);
    expect(out.size).toBe(2);
    expect(out.get("org_a")!.sources.map((s) => s.id)).toEqual(["src_1", "src_3"]);
    expect(out.get("org_b")!.sources.map((s) => s.id)).toEqual(["src_2"]);
  });

  it("exposes orgSlug and orgName on each group", () => {
    const out = groupByOrg([c({ orgId: "org_x", orgSlug: "x", orgName: "Org X" })]);
    const group = out.get("org_x")!;
    expect(group.orgSlug).toBe("x");
    expect(group.orgName).toBe("Org X");
  });
});
