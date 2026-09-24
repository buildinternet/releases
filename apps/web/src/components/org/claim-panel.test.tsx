import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { OrgClaim } from "@buildinternet/releases-api-types";
import type { LocatorPreview } from "@/lib/listing-locations";
import { VerifiedBody } from "./claim-panel.tsx";
import { OwnDomainLink } from "./own-domain-link.tsx";

const claim: OrgClaim = {
  id: "claim_1",
  org: { slug: "acme", name: "Acme", webUrl: "https://releases.sh/acme" },
  status: "verified",
  method: "dns-txt",
  createdAt: "2026-09-01T00:00:00Z",
  verifiedAt: "2026-09-02T00:00:00Z",
  expiresAt: "2026-10-01T00:00:00Z",
};
const live: LocatorPreview[] = [
  { kind: "feed", locator: "https://acme.test/feed.xml", classification: "tier1-live" },
];

describe("VerifiedBody", () => {
  it("points a tracked org's owner at publish tokens, not promotion", () => {
    const html = renderToStaticMarkup(
      <VerifiedBody
        claim={claim}
        tracked
        promotionEnabled
        live={live}
        queued={[]}
        onPromote={() => {}}
      />,
    );
    expect(html).toContain("Verified via DNS TXT record.");
    expect(html).toContain('href="/account/webhooks"');
    expect(html).not.toContain("Enable tracking");
  });

  it("keeps the promotion CTA for a stub", () => {
    const html = renderToStaticMarkup(
      <VerifiedBody
        claim={claim}
        tracked={false}
        promotionEnabled
        live={live}
        queued={[]}
        onPromote={() => {}}
      />,
    );
    expect(html).toContain("Enable tracking");
    expect(html).not.toContain("/account/webhooks");
  });
});

describe("OwnDomainLink", () => {
  it("renders only the trigger while closed (no claim panel mounted)", () => {
    const html = renderToStaticMarkup(<OwnDomainLink orgSlug="acme" domain="acme.test" />);
    expect(html).toContain("Own acme.test?");
    expect(html).not.toContain("Verify you own");
  });
});
