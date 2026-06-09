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
    source: { slug: "blog", name: "Acme Blog", type: "feed", orgSlug: "acme" },
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
          source: { slug: "blog", name: "Acme Blog", type: "feed", orgSlug: "acme" },
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
