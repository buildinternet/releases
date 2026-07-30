import { describe, expect, it } from "bun:test";
import {
  buildStalenessDigestEmail,
  countNeedsAttention,
} from "../src/lib/staleness-digest-email.js";
import type { StaleSourceEntry } from "../src/cron/source-staleness.js";
import type { ProviderHealthEntry } from "../src/cron/provider-health.js";

const firstPartyEntry = (over: Partial<StaleSourceEntry> = {}): StaleSourceEntry => ({
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
  ...over,
});

const providerEntry = (over: Partial<ProviderHealthEntry> = {}): ProviderHealthEntry => ({
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
  ...over,
});

describe("buildStalenessDigestEmail", () => {
  it("builds a combined subject and sections for both scan types", () => {
    const { subject, text, html } = buildStalenessDigestEmail({
      scannedAt: "2026-06-18T04:00:00.000Z",
      webOrigin: "https://releases.sh",
      firstParty: [firstPartyEntry()],
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
      providerOutageActive: false,
    });
    expect(subject).toBe("[staleness] 2 sources need attention: Vercel, Acme");
    expect(text).toContain("FIRST-PARTY — POSSIBLE INGEST BREAKAGE (1)");
    expect(text).toContain("Vercel (vercel) — next-js");
    expect(text).toContain("FIRECRAWL MONITORS (1)");
    expect(text).toContain("https://releases.sh/vercel/next-js");
    expect(text).toContain("Internal daily digest");
    expect(html).toContain("Source staleness digest");
    expect(html).toContain("vercel/next-js");
  });

  it("leads the subject and body with a provider-health section when a quota shutoff is active", () => {
    const { subject, text } = buildStalenessDigestEmail({
      scannedAt: "2026-07-23T00:10:00.000Z",
      webOrigin: "https://releases.sh",
      firstParty: [],
      firecrawl: [],
      providerHealth: [providerEntry()],
      providerOutageActive: true,
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
  });

  it("reframes provider entries as aftermath when the outage has cleared", () => {
    // The 2026-07-30 regression: two Firecrawl webhook-driven sources whose
    // last attempts predated the cap being raised were emailed as "unable to
    // ingest" days after every other source had recovered.
    const { subject, text } = buildStalenessDigestEmail({
      scannedAt: "2026-07-30T04:00:00.000Z",
      webOrigin: "https://releases.sh",
      firstParty: [],
      firecrawl: [],
      providerHealth: [providerEntry()],
      providerOutageActive: false,
    });
    expect(subject).not.toContain("provider quota shutoff");
    expect(subject).toBe("[staleness] 1 source needs attention: OpenAI");
    expect(text).not.toContain("unable to ingest at all");
    expect(text).toContain("PROVIDER OUTAGE AFTERMATH (1)");
    expect(text).toContain("Re-fetch these manually");
    expect(text).toContain("failed 2026-07-23T00:10:00.000Z");
  });

  it("splits upstream-quiet transparent sources out of the actionable counts", () => {
    const { subject, text } = buildStalenessDigestEmail({
      scannedAt: "2026-07-30T04:00:00.000Z",
      webOrigin: "https://releases.sh",
      firstParty: [
        firstPartyEntry(),
        firstPartyEntry({ sourceId: "src_gh", slug: "some-sdk", sourceType: "github" }),
        firstPartyEntry({ sourceId: "src_app", slug: "some-app", sourceType: "appstore" }),
      ],
      firecrawl: [],
      providerHealth: [],
      providerOutageActive: false,
    });
    // Only the scrape source is actionable; the github/appstore ones are
    // informational and must not inflate the headline.
    expect(subject).toBe("[staleness] 1 source needs attention: Vercel");
    expect(text).toContain("1 source(s) need attention.");
    expect(text).toContain("A further 2 are healthy but quiet upstream");
    expect(text).toContain("FIRST-PARTY — POSSIBLE INGEST BREAKAGE (1)");
    expect(text).toContain("UPSTREAM QUIET (2)");
  });
});

describe("countNeedsAttention", () => {
  it("counts opaque first-party, firecrawl, and provider entries but not transparent quiet ones", () => {
    expect(
      countNeedsAttention({
        firstParty: [
          firstPartyEntry(),
          firstPartyEntry({ sourceId: "src_gh", sourceType: "github" }),
          firstPartyEntry({ sourceId: "src_v", sourceType: "video" }),
        ],
        firecrawl: [],
        providerHealth: [providerEntry()],
      }),
    ).toBe(2);
    expect(
      countNeedsAttention({
        firstParty: [firstPartyEntry({ sourceType: "github" })],
        firecrawl: [],
        providerHealth: [],
      }),
    ).toBe(0);
  });
});
