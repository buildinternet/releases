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
      providerHealth: [],
    });
    expect(subject).toBe("[staleness] 2 sources overdue: Vercel, Acme");
    expect(text).toContain("FIRST-PARTY (1)");
    expect(text).toContain("Vercel (vercel) — next-js");
    expect(text).toContain("FIRECRAWL MONITORS (1)");
    expect(text).toContain("https://releases.sh/vercel/next-js");
    expect(text).toContain("Internal daily digest");
    expect(html).toContain("Source staleness digest");
    expect(html).toContain("vercel/next-js");
  });

  it("leads the subject and body with a provider-health section when a quota shutoff is present", () => {
    const { subject, text } = buildStalenessDigestEmail({
      scannedAt: "2026-07-23T00:10:00.000Z",
      webOrigin: "https://releases.sh",
      firstParty: [],
      firecrawl: [],
      providerHealth: [
        {
          sourceId: "src_c",
          slug: "release-notes",
          orgSlug: "openai",
          orgName: "OpenAI",
          provider: "anthropic",
          lastFetchedAt: "2026-07-21T00:00:00.000Z",
          lastAttemptAt: "2026-07-23T00:10:00.000Z",
          regainAccessAt: "2026-08-01T00:00:00.000Z",
          message:
            "You have reached your specified API usage limits. You will regain access on 2026-08-01 at 00:00 UTC.",
        },
      ],
    });
    expect(subject).toContain("provider quota shutoff");
    expect(subject).toContain("OpenAI");
    expect(text).toContain("PROVIDER HEALTH (1)");
    expect(text).toContain("provider anthropic");
    expect(text).toContain("2026-08-01T00:00:00.000Z");
    expect(text).toContain("last evaluated 2026-07-21T00:00:00.000Z");
    // The lead sentence is the first thing an operator reads. Describing a
    // quota shutoff as merely "overdue for new releases" is the exact
    // misreading this section exists to prevent, so pin the wording.
    expect(text).toContain("unable to ingest at all");
    expect(text).not.toContain("are overdue for new releases or monitor deliveries.");
  });
});
