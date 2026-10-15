import { describe, expect, it } from "bun:test";
import {
  dedupeByContentIdentity,
  normalizeReleaseBody,
  publishedDay,
  versionIdentity,
  versionsCompatible,
} from "./content-dedup.js";

const BODY = `## May 2026 updates

- Added numeric field types for structured outputs
- Fixed skip-code handling when the caller retries a partial batch
- Documented the new \`max_tokens\` ceiling for the responses API
`;

describe("normalizeReleaseBody", () => {
  it("drops a reworded leading heading and markdown chrome", () => {
    const reworded = BODY.replace("## May 2026 updates", "## Updates for May 2026");
    expect(normalizeReleaseBody(reworded, "Updates for May 2026")).toBe(
      normalizeReleaseBody(BODY, "May 2026 updates"),
    );
  });

  it("ignores link targets so a new anchor in the body does not change the key", () => {
    const a =
      "Fixed retry behavior for partial batches when the caller sends a cursor.\nSee [docs](https://example.com/changelog#old).";
    const b =
      "Fixed retry behavior for partial batches when the caller sends a cursor.\nSee [docs](https://example.com/changelog#new).";
    expect(normalizeReleaseBody(a)).toBe(normalizeReleaseBody(b));
  });
});

describe("publishedDay", () => {
  it("uses the UTC day for datetimes and keeps date-only strings", () => {
    expect(publishedDay("2026-10-14")).toBe("2026-10-14");
    expect(publishedDay("2026-10-14T23:30:00.000Z")).toBe("2026-10-14");
    expect(publishedDay(new Date("2026-10-14T23:30:00-07:00"))).toBe("2026-10-15");
    expect(publishedDay("")).toBeNull();
    expect(publishedDay(null)).toBeNull();
  });
});

describe("versionIdentity", () => {
  it("parses package@version, a lowercase package prefix, and a bare semver", () => {
    expect(versionIdentity("@sanity/client@3.68.0")).toEqual({
      packageName: "@sanity/client",
      token: "3.68.0",
    });
    expect(versionIdentity(null, "ollama-python 0.12.0")).toEqual({
      packageName: "ollama-python",
      token: "0.12.0",
    });
    expect(versionIdentity("0.12.0", "ollama-python 0.12.0")).toEqual({
      packageName: "ollama-python",
      token: "0.12.0",
    });
    expect(versionIdentity("v1.2.0")).toEqual({ packageName: null, token: "1.2.0" });
    expect(versionIdentity("1.2.0-rc.1")).toEqual({ packageName: null, token: "1.2.0-rc.1" });
  });

  it("does not treat a prose title as a package name", () => {
    expect(versionIdentity(null, "Released 1.2.0")).toEqual({
      packageName: null,
      token: "1.2.0",
    });
    expect(versionIdentity(null, "May 2026 updates")).toBeNull();
  });
});

describe("versionsCompatible", () => {
  it("treats a missing version as the same entry and keeps distinct lines apart", () => {
    expect(versionsCompatible(null, versionIdentity("1.2.0"))).toBe(true);
    expect(versionsCompatible(versionIdentity("1.2.0"), versionIdentity("v1.2.0"))).toBe(true);
    expect(versionsCompatible(versionIdentity("1.2.0-rc.1"), versionIdentity("1.2.0"))).toBe(false);
    expect(
      versionsCompatible(versionIdentity("ollama 0.12.0"), versionIdentity("ollama-python 0.12.0")),
    ).toBe(false);
  });
});

describe("dedupeByContentIdentity", () => {
  const hash = "abc123";
  const existing = [
    {
      url: "https://x/p#may-2026",
      publishedAt: "2026-05-01T00:00:00.000Z",
      bodyHash: hash,
      title: "May 2026 updates",
      version: null,
    },
  ];

  it("drops a reworded title on the same day under a new anchor", () => {
    const { kept, dropped } = dedupeByContentIdentity(
      [
        {
          title: "Updates for May 2026",
          url: "https://x/p#updates-for-may-2026",
          publishedAt: "2026-05-01",
          bodyHash: hash,
        },
      ],
      existing,
    );
    expect(dropped).toBe(1);
    expect(kept).toHaveLength(0);
  });

  it("keeps the same body on a different day", () => {
    const { dropped, kept } = dedupeByContentIdentity(
      [
        {
          title: "Updates for May 2026",
          publishedAt: "2026-06-01",
          bodyHash: hash,
          url: "https://x/p#june",
        },
      ],
      existing,
    );
    expect(dropped).toBe(0);
    expect(kept).toHaveLength(1);
  });

  it("keeps a same-URL re-fetch for the upsert path", () => {
    const { dropped } = dedupeByContentIdentity(
      [
        {
          title: "May 2026 updates",
          url: "https://x/p#may-2026",
          publishedAt: "2026-05-01",
          bodyHash: hash,
        },
      ],
      existing,
    );
    expect(dropped).toBe(0);
  });

  it("keeps a backport and a sibling package that share the body", () => {
    const backport = dedupeByContentIdentity(
      [
        {
          title: "1.1.5",
          version: "1.1.5",
          publishedAt: "2026-05-01",
          bodyHash: hash,
          url: "https://x/p#1-1-5",
        },
      ],
      [{ ...existing[0], version: "1.2.0", title: "1.2.0" }],
    );
    expect(backport.dropped).toBe(0);

    const sibling = dedupeByContentIdentity(
      [
        {
          title: "ollama-python 0.12.0",
          version: "0.12.0",
          publishedAt: "2026-05-01",
          bodyHash: hash,
          url: "https://x/p#py",
        },
      ],
      [{ ...existing[0], title: "ollama 0.12.0", version: "0.12.0" }],
    );
    expect(sibling.dropped).toBe(0);
  });

  it("drops a second copy inside the same batch", () => {
    const { kept, dropped } = dedupeByContentIdentity(
      [
        { title: "A", publishedAt: "2026-05-01", bodyHash: hash, url: "https://x/p#a" },
        {
          title: "A reworded",
          publishedAt: "2026-05-01T12:00:00.000Z",
          bodyHash: hash,
          url: "https://x/p#b",
        },
      ],
      [],
    );
    expect(dropped).toBe(1);
    expect(kept.map((r) => r.title)).toEqual(["A"]);
  });

  it("drops a repeated version line when that line is already stored beside another", () => {
    const { dropped, kept } = dedupeByContentIdentity(
      [
        {
          title: "1.1.5",
          version: "1.1.5",
          publishedAt: "2026-05-01",
          bodyHash: hash,
          url: "https://x/p#1-1-5-again",
        },
      ],
      [
        { ...existing[0], version: "1.2.0", title: "1.2.0", url: "https://x/p#1-2-0" },
        { ...existing[0], version: "1.1.5", title: "1.1.5", url: "https://x/p#1-1-5" },
      ],
    );
    expect(dropped).toBe(1);
    expect(kept).toHaveLength(0);
  });

  it("keeps a body that is too short to hash", () => {
    const { dropped } = dedupeByContentIdentity(
      [{ title: "Bug fixes", publishedAt: "2026-05-01", bodyHash: null, url: "https://x/p#bf" }],
      [{ title: "Fixes", publishedAt: "2026-05-01", bodyHash: null, url: "https://x/p#old" }],
    );
    expect(dropped).toBe(0);
  });
});
