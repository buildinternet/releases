import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AddOrgWebhookLink, AddOrgWebhookMenuItem } from "./add-org-webhook-link.tsx";

describe("AddOrgWebhookLink", () => {
  it("renders a quiet more-menu trigger instead of a header pill", () => {
    const html = renderToStaticMarkup(<AddOrgWebhookLink orgSlug="vercel" orgName="Vercel" />);
    expect(html).toContain('aria-label="More actions"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    // Closed: the deep-link is not in the header.
    expect(html).not.toContain("/account/webhooks");
    expect(html).not.toContain("Add webhook");
  });
});

describe("AddOrgWebhookMenuItem", () => {
  it("deep-links to the webhooks create form scoped to the org", () => {
    const html = renderToStaticMarkup(<AddOrgWebhookMenuItem orgSlug="vercel" orgName="Vercel" />);
    expect(html).toContain("Add webhook");
    expect(html).toContain('aria-label="Add webhook for Vercel"');
    expect(html).toContain("/account/webhooks?scope=org&amp;org=vercel#add-webhook");
  });
});
