import { describe, expect, it } from "bun:test";
import { buildDigestEmail, sendDigestEmail } from "../src/lib/digest-email.js";
import type { ReleaseLatestItem } from "@buildinternet/releases-api-types";

function rel(over: Partial<ReleaseLatestItem>): ReleaseLatestItem {
  return {
    id: "rel_1",
    version: null,
    type: "feature",
    title: "Thing shipped",
    summary: "We shipped a thing.",
    titleGenerated: null,
    titleShort: "Thing",
    publishedAt: "2026-06-08T00:00:00.000Z",
    url: "https://acme.com/changelog/1",
    media: [],
    source: { slug: "blog", name: "Acme Blog", type: "feed", orgSlug: "acme", orgName: "Acme" },
    product: { slug: "widget", name: "Widget" },
    coverageCount: 0,
    contentChars: null,
    contentTokens: null,
    ...over,
  } as ReleaseLatestItem;
}

describe("buildDigestEmail", () => {
  it("renders subject, text, and html with release + unsubscribe link", () => {
    const { subject, text, html } = buildDigestEmail({
      recipientName: "T",
      cadence: "daily",
      releases: [
        rel({ titleShort: "ShortHeadline", title: "RawLongTitle" }),
        rel({
          id: "rel_2",
          title: "Second",
          source: {
            slug: "blog",
            name: "Acme Blog",
            type: "feed",
            orgSlug: "acme",
            orgName: "Acme",
          },
        }),
      ],
      baseUrl: "https://releases.sh",
      manageUrl: "https://releases.sh/following",
      unsubscribeUrl: "https://api.releases.sh/v1/digest/unsubscribe/reld_x",
    });
    expect(subject).toContain("2");
    expect(text).toContain("ShortHeadline"); // titleShort preferred over title, matching the feed UI
    expect(text).not.toContain("RawLongTitle");
    expect(text).toContain("https://releases.sh/release/rel_1");
    expect(text).toContain("reld_x");
    expect(html).toContain("Unsubscribe");
    expect(html).toContain("https://releases.sh/following");
    // Heading is the org's display name, not the source name.
    expect(text).toContain("ACME");
    expect(text).not.toContain("Acme Blog");
    expect(html).toContain(">Acme</a>");
  });

  it("collapses GitHub version tags into a per-product rollup with notes", () => {
    const ghSource = {
      slug: "sdk",
      name: "acme/sdk",
      type: "github" as const,
      orgSlug: "acme",
      orgName: "Acme",
    };
    const { text, html } = buildDigestEmail({
      recipientName: "T",
      cadence: "daily",
      releases: [
        rel({
          id: "t1",
          title: "v4.2.1",
          version: "4.2.1",
          titleShort: "Fixed a socket leak",
          summary: null,
          source: ghSource,
        }),
        rel({
          id: "t2",
          title: "v4.2.0",
          version: "4.2.0",
          titleShort: "Added a retry flag",
          summary: null,
          source: ghSource,
        }),
      ],
      baseUrl: "https://releases.sh",
      manageUrl: "https://releases.sh/following",
      unsubscribeUrl: "https://api.releases.sh/v1/digest/unsubscribe/reld_x",
    });
    // Product header with count, each version carrying its one-line note + link.
    expect(text).toContain("Widget · 2 updates");
    expect(text).toContain("4.2.1 — Fixed a socket leak");
    expect(text).toContain("4.2.0 — Added a retry flag");
    expect(text).toContain("https://releases.sh/release/t1");
    expect(html).toContain(">4.2.1</a>");
    expect(html).toContain("Fixed a socket leak");
    expect(html).toContain("· 2 updates");
    // No "+N more" when everything fits.
    expect(text).not.toContain("more:");
  });

  it("ranks substantive tags first and folds the rest into +N more", () => {
    const ghSource = {
      slug: "workers-sdk",
      name: "cloudflare/workers-sdk",
      type: "github" as const,
      orgSlug: "cloudflare",
      orgName: "Cloudflare",
    };
    // Newest-first: a dependency-bump (no titleShort, boilerplate body) leads, then
    // four substantive tags. The rollup should skip the bump, show the newest 3
    // substantive ones, and fold the remaining 2 (1 substantive + the bump) away.
    const dep = (id: string, v: string) =>
      rel({
        id,
        version: v,
        title: v,
        titleShort: null,
        summary: "### Patch Changes\n\n- Updated dependencies",
        source: ghSource,
        product: undefined,
      });
    const real = (id: string, v: string, short: string) =>
      rel({
        id,
        version: v,
        title: v,
        titleShort: short,
        summary: null,
        source: ghSource,
        product: undefined,
      });
    const { text, html } = buildDigestEmail({
      recipientName: "T",
      cadence: "daily",
      releases: [
        dep("d1", "@cloudflare/cli-shared@0.1.8"),
        real("r1", "wrangler@4.101.0", "Autoconfig graduates from experimental"),
        real("r2", "@cloudflare/workers-auth@0.3.0", "--temporary flag for preview accounts"),
        real("r3", "miniflare@4.20260616.0", "cf.image transforms now work locally"),
        real("r4", "@cloudflare/vite-plugin@1.41.0", "Experimental cfBuildOutput option"),
      ],
      baseUrl: "https://releases.sh",
      manageUrl: "https://releases.sh/following",
      unsubscribeUrl: "https://api.releases.sh/v1/digest/unsubscribe/reld_x",
    });
    expect(text).toContain("· 5 updates");
    // Substantive tags surface (in newest-first order), the dependency bump does not.
    expect(text).toContain("Autoconfig graduates from experimental");
    expect(text).toContain("--temporary flag for preview accounts");
    expect(text).toContain("cf.image transforms now work locally");
    expect(text).not.toContain("Updated dependencies");
    expect(text).not.toContain("Experimental cfBuildOutput option"); // 4th substantive, hidden
    // Overflow (5 total - 3 shown) links to the source page.
    expect(text).toContain("+ 2 more: https://releases.sh/cloudflare/workers-sdk");
    expect(html).toContain("+ 2 more →");
    expect(html).toContain("https://releases.sh/cloudflare/workers-sdk");
  });

  it("falls back to the source name when the source has no org", () => {
    const { text } = buildDigestEmail({
      recipientName: null,
      cadence: "daily",
      releases: [
        rel({
          source: { slug: "indie", name: "Indie Feed", type: "feed", orgSlug: null, orgName: null },
        }),
      ],
      baseUrl: "https://releases.sh",
      manageUrl: "https://releases.sh/following",
      unsubscribeUrl: "https://api.releases.sh/v1/digest/unsubscribe/reld_x",
    });
    expect(text).toContain("INDIE FEED");
  });
});

describe("sendDigestEmail", () => {
  it("returns no_binding when AUTH_EMAIL is absent", async () => {
    const res = await sendDigestEmail(
      { DIGEST_EMAIL_FROM: "digests@releases.sh" },
      {
        to: "t@e.com",
        recipientName: "T",
        cadence: "daily",
        releases: [rel({})],
        baseUrl: "https://releases.sh",
        manageUrl: "https://releases.sh/following",
        unsubscribeUrl: "https://api.releases.sh/v1/digest/unsubscribe/reld_x",
      },
    );
    expect(res.sent).toBe(false);
    expect(res.reason).toBe("no_binding");
  });

  it("sends with a List-Unsubscribe header through the binding", async () => {
    let captured: any = null;
    const res = await sendDigestEmail(
      {
        AUTH_EMAIL: {
          send: async (m: any) => {
            captured = m;
            return { messageId: "m1" };
          },
        } as any,
        DIGEST_EMAIL_FROM: "digests@releases.sh",
      },
      {
        to: "t@e.com",
        recipientName: "T",
        cadence: "weekly",
        releases: [rel({})],
        baseUrl: "https://releases.sh",
        manageUrl: "https://releases.sh/following",
        unsubscribeUrl: "https://api.releases.sh/v1/digest/unsubscribe/reld_x",
      },
    );
    expect(res.sent).toBe(true);
    expect(captured.from).toContain("digests@releases.sh");
    expect(captured.headers["List-Unsubscribe"]).toContain("reld_x");
    expect(captured.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });
});
