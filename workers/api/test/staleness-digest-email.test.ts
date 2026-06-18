import { describe, expect, it } from "bun:test";
import { buildStalenessDigestEmail } from "../src/lib/staleness-digest-email.js";

describe("buildStalenessDigestEmail", () => {
  it("builds a combined subject and sections for both scan types", () => {
    const { subject, text, html } = buildStalenessDigestEmail({
      scannedAt: "2026-06-18T04:00:00.000Z",
      webOrigin: "https://releases.sh",
      firstParty: [
        {
          sourceId: "src_a",
          slug: "next-js",
          orgSlug: "vercel",
          orgName: "Vercel",
          sourceType: "scrape",
          medianGapDays: 7,
          windowDays: 21,
          daysSinceNewest: 40,
          newestRelease: "2026-04-01T00:00:00.000Z",
          lastSeenAt: "2026-06-17T00:00:00.000Z",
        },
      ],
      firecrawl: [
        {
          sourceId: "src_b",
          slug: "changelog",
          orgSlug: "acme",
          orgName: "Acme",
          lastFetchedAt: "2026-06-10T00:00:00.000Z",
          staleHours: 48,
          thresholdBasis: "floor",
        },
      ],
    });
    expect(subject).toBe("[staleness] 2 sources overdue");
    expect(text).toContain("First-party (1)");
    expect(text).toContain("Vercel (vercel) — next-js");
    expect(text).toContain("Firecrawl monitors (1)");
    expect(text).toContain("https://releases.sh/vercel/next-js");
    expect(text).toContain("Internal daily digest");
    expect(html).toContain("Source staleness digest");
    expect(html).toContain("vercel/next-js");
  });
});
