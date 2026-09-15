import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AddOrgWebhookLink } from "./add-org-webhook-link.tsx";

describe("AddOrgWebhookLink", () => {
  it("deep-links to the webhooks create form scoped to the org", () => {
    const html = renderToStaticMarkup(<AddOrgWebhookLink orgSlug="vercel" orgName="Vercel" />);
    expect(html).toContain("Add webhook");
    expect(html).toContain('aria-label="Add webhook for Vercel"');
    expect(html).toContain("/account/webhooks?scope=org&amp;org=vercel#add-webhook");
  });
});
