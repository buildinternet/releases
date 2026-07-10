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
    // Wrapped in the shared document shell — without it the body has no
    // max-width and lines run the full width of a wide reading pane.
    expect(html).toStartWith("<!doctype html>");
    expect(html).toContain("max-width:560px");
  });

  it("compresses a per-product version burst to the newest release + notes", () => {
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
    // Product header counts all releases, but only the newest version shows —
    // the rest fold into "and N more". No enumerated version list.
    expect(text).toContain("Widget · 2 releases");
    expect(text).toContain("4.2.1 (and 1 more)");
    expect(text).toContain("Latest — Fixed a socket leak");
    // "and N more" links to the product page; the pill itself links to the release.
    expect(text).toContain("https://releases.sh/acme/widget");
    expect(html).toContain('href="https://releases.sh/release/t1"');
    expect(html).toContain(">4.2.1</a>");
    expect(html).toContain("and 1 more");
    expect(html).toContain("· 2 releases");
    // The older version is NOT enumerated on its own line.
    expect(text).not.toContain("Added a retry flag");
    expect(text).not.toContain("4.2.0");
  });

  it("picks the newest release WITH notes as the rollup representative", () => {
    const ghSource = {
      slug: "workers-sdk",
      name: "cloudflare/workers-sdk",
      type: "github" as const,
      orgSlug: "cloudflare",
      orgName: "Cloudflare",
    };
    // Newest-first: a dependency-bump (no titleShort, boilerplate body) leads. The
    // rollup should skip it as the representative — showing the newest release that
    // carries a real note — while still counting it in "· N releases" / "and N more".
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
    expect(text).toContain("· 5 releases");
    // The newest substantive release is the representative (version + note agree);
    // the leading dependency bump is skipped, and the other four fold away.
    expect(text).toContain("wrangler@4.101.0 (and 4 more)");
    expect(text).toContain("Latest — Autoconfig graduates from experimental");
    expect(text).not.toContain("Updated dependencies");
    expect(text).not.toContain("--temporary flag for preview accounts"); // folded
    expect(text).not.toContain("cf.image transforms now work locally"); // folded
    // "and N more" links to the product/source page.
    expect(text).toContain("and 4 more");
    expect(html).toContain("and 4 more →");
    expect(html).toContain("https://releases.sh/cloudflare/workers-sdk");
  });

  it("dates the daily subject with the start of the covered window (ET)", () => {
    const { subject, html } = buildDigestEmail({
      recipientName: "T",
      cadence: "daily",
      releases: [rel({})],
      baseUrl: "https://releases.sh",
      manageUrl: "https://releases.sh/following",
      unsubscribeUrl: "https://api.releases.sh/v1/digest/unsubscribe/reld_x",
      // Ran 13:00 UTC (09:00 ET) on Jun 24, so it covers Jun 23 09:00 ET onward —
      // the digest is dated for the day whose news it actually carries.
      referenceDate: "2026-06-24T13:00:00.000Z",
    });
    expect(subject).toBe("Releases digest — Jun 23, 2026 · 1 update");
    // The HTML masthead mirrors the dated subject.
    expect(html).toContain("Jun 23, 2026");
    expect(html).not.toContain("Jun 24, 2026");
  });

  it("labels the weekly subject with the start of the covered window", () => {
    const { subject } = buildDigestEmail({
      recipientName: "T",
      cadence: "weekly",
      releases: [rel({}), rel({ id: "rel_2" })],
      baseUrl: "https://releases.sh",
      manageUrl: "https://releases.sh/following",
      unsubscribeUrl: "https://api.releases.sh/v1/digest/unsubscribe/reld_x",
      referenceDate: "2026-06-24T13:00:00.000Z",
    });
    expect(subject).toBe("Releases digest — week of Jun 17, 2026 · 2 updates");
  });

  it("omits the date when no referenceDate is supplied (backward compatible)", () => {
    const { subject } = buildDigestEmail({
      recipientName: "T",
      cadence: "daily",
      releases: [rel({})],
      baseUrl: "https://releases.sh",
      manageUrl: "https://releases.sh/following",
      unsubscribeUrl: "https://api.releases.sh/v1/digest/unsubscribe/reld_x",
    });
    expect(subject).toBe("Releases digest — 1 update");
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

  // Common render config for the importance-ordering cases.
  const base = {
    recipientName: null,
    cadence: "daily" as const,
    baseUrl: "https://releases.sh",
    manageUrl: "https://releases.sh/following",
    unsubscribeUrl: "https://api.releases.sh/v1/digest/unsubscribe/reld_x",
  };
  const acme = {
    slug: "blog",
    name: "Acme Blog",
    type: "feed" as const,
    orgSlug: "acme",
    orgName: "Acme",
  };

  it("leads an org's posts with the high-signal one, even when published earlier", () => {
    const { text } = buildDigestEmail({
      ...base,
      // Arrives published-desc from the query: the newer, unremarkable post first.
      releases: [
        rel({
          id: "r_norm",
          title: "Routine update",
          titleShort: "Routine update",
          importance: null,
          publishedAt: "2026-06-09T00:00:00.000Z",
          source: acme,
        }),
        rel({
          id: "r_hot",
          title: "Notable launch",
          titleShort: "Notable launch",
          importance: 5,
          publishedAt: "2026-06-08T00:00:00.000Z",
          source: acme,
        }),
      ],
    });
    expect(text.indexOf("Notable launch")).toBeLessThan(text.indexOf("Routine update"));
  });

  it("floats an org carrying a high-signal release above a more-recent but unremarkable org", () => {
    const alpha = {
      slug: "a",
      name: "Alpha",
      type: "feed" as const,
      orgSlug: "alpha",
      orgName: "Alpha",
    };
    const beta = {
      slug: "b",
      name: "Beta",
      type: "feed" as const,
      orgSlug: "beta",
      orgName: "Beta",
    };
    const { text } = buildDigestEmail({
      ...base,
      releases: [
        rel({
          id: "r_a",
          title: "Alpha routine",
          titleShort: "Alpha routine",
          importance: null,
          publishedAt: "2026-06-10T00:00:00.000Z",
          source: alpha,
        }),
        rel({
          id: "r_b",
          title: "Beta breaking change",
          titleShort: "Beta breaking change",
          importance: 5,
          publishedAt: "2026-06-08T00:00:00.000Z",
          source: beta,
        }),
      ],
    });
    expect(text.indexOf("BETA")).toBeLessThan(text.indexOf("ALPHA"));
  });

  it("keeps NULL-importance posts in chronological order, never below a scored-low post", () => {
    const { text } = buildDigestEmail({
      ...base,
      releases: [
        rel({
          id: "r_null",
          title: "Unscored recent",
          titleShort: "Unscored recent",
          importance: null,
          publishedAt: "2026-06-09T00:00:00.000Z",
          source: acme,
        }),
        rel({
          id: "r_low",
          title: "Low scored older",
          titleShort: "Low scored older",
          importance: 2,
          publishedAt: "2026-06-08T00:00:00.000Z",
          source: acme,
        }),
      ],
    });
    // Neither is high-signal, so published-desc is preserved and the NULL row (more
    // recent) stays ahead of the scored-low one — unknown is not treated as unimportant.
    expect(text.indexOf("Unscored recent")).toBeLessThan(text.indexOf("Low scored older"));
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
