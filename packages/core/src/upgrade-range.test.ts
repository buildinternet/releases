import { describe, expect, test } from "bun:test";
import { resolveUpgradeRange } from "./upgrade-range";
import { computeVersionSort } from "./version-sort";

interface Rel {
  version: string | null;
  versionSort: string | null;
  publishedAt: string | null;
  summary: string | null;
}

/** Build a release row with versionSort derived the same way the ingest path does. */
function rel(
  version: string | null,
  publishedAt: string | null,
  summary = `notes for ${version}`,
): Rel {
  return { version, versionSort: computeVersionSort(version), publishedAt, summary };
}

const RELEASES: Rel[] = [
  rel("1.0.0", "2026-01-01T00:00:00Z"),
  rel("1.1.0", "2026-02-01T00:00:00Z"),
  rel("1.2.0", "2026-03-01T00:00:00Z"),
  rel("2.0.0", "2026-04-01T00:00:00Z"),
  rel("2.1.0", "2026-05-01T00:00:00Z"),
];

describe("resolveUpgradeRange — version-bounded", () => {
  test("returns (from, to]: from exclusive, to inclusive, ordered ascending", () => {
    const out = resolveUpgradeRange(RELEASES, { from: "1.0.0", to: "2.0.0" });
    expect(out.map((r) => r.version)).toEqual(["1.1.0", "1.2.0", "2.0.0"]);
  });

  test("to is inclusive", () => {
    const out = resolveUpgradeRange(RELEASES, { from: "1.1.0", to: "1.2.0" });
    expect(out.map((r) => r.version)).toEqual(["1.2.0"]);
  });

  test("from is exclusive (you already have it)", () => {
    const out = resolveUpgradeRange(RELEASES, { from: "1.2.0", to: "2.1.0" });
    expect(out.map((r) => r.version)).toEqual(["2.0.0", "2.1.0"]);
    expect(out.map((r) => r.version)).not.toContain("1.2.0");
  });

  test("from === to → empty (nothing changed)", () => {
    expect(resolveUpgradeRange(RELEASES, { from: "2.0.0", to: "2.0.0" })).toEqual([]);
  });

  test("reversed range (from newer than to) → empty, not error", () => {
    expect(resolveUpgradeRange(RELEASES, { from: "2.1.0", to: "1.0.0" })).toEqual([]);
  });

  test("bounds need not match an exact release — returns everything ≤ to", () => {
    // no 1.5.0 release exists; to=1.5.0 still includes 1.1.0 + 1.2.0
    const out = resolveUpgradeRange(RELEASES, { from: "1.0.0", to: "1.5.0" });
    expect(out.map((r) => r.version)).toEqual(["1.1.0", "1.2.0"]);
  });

  test("prereleases sort globally below releases — excluded from a stable→stable range", () => {
    // computeVersionSort prefixes ALL prereleases with `0_` (vs `1_` for
    // releases), so a 1.1.0-rc.1 sorts below even 1.0.0 and is NOT in the
    // (1.0.0, 1.1.0] stable range. A known quirk of the sort key; fine for the
    // stable-upgrade use case this endpoint serves.
    const withRc: Rel[] = [
      rel("1.0.0", "2026-01-01T00:00:00Z"),
      rel("1.1.0-rc.1", "2026-01-15T00:00:00Z"),
      rel("1.1.0", "2026-02-01T00:00:00Z"),
    ];
    const out = resolveUpgradeRange(withRc, { from: "1.0.0", to: "1.1.0" });
    expect(out.map((r) => r.version)).toEqual(["1.1.0"]);
  });

  test("releases with null versionSort are excluded from a version-bounded range", () => {
    const mixed: Rel[] = [...RELEASES, rel("jaguar", "2026-03-15T00:00:00Z")]; // versionSort null
    const out = resolveUpgradeRange(mixed, { from: "1.0.0", to: "2.0.0" });
    expect(out.map((r) => r.version)).toEqual(["1.1.0", "1.2.0", "2.0.0"]); // no "jaguar"
  });

  test("preserves the caller's full row shape (generic)", () => {
    const out = resolveUpgradeRange(RELEASES, { from: "1.1.0", to: "1.2.0" });
    expect(out[0].summary).toBe("notes for 1.2.0");
  });
});

describe("resolveUpgradeRange — date-bounded fallback (non-numeric bounds)", () => {
  const codenames: Rel[] = [
    rel("jaguar", "2026-01-01T00:00:00Z"),
    rel("kestrel", "2026-02-01T00:00:00Z"),
    rel("lynx", "2026-03-01T00:00:00Z"),
    rel("mantis", "2026-04-01T00:00:00Z"),
  ];

  test("non-numeric from/to fall back to publishedAt order, (from, to]", () => {
    const out = resolveUpgradeRange(codenames, { from: "jaguar", to: "lynx" });
    expect(out.map((r) => r.version)).toEqual(["kestrel", "lynx"]);
  });

  test("fallback returns empty when from/to can't be located by version string", () => {
    expect(resolveUpgradeRange(codenames, { from: "jaguar", to: "ocelot" })).toEqual([]);
  });
});
