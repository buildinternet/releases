import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { WebhooksPanel } from "./webhooks-panel.tsx";

describe("WebhooksPanel prefill", () => {
  it("opens the create form on Org scope with the org slug filled", () => {
    const html = renderToStaticMarkup(
      <WebhooksPanel initialWebhooks={[]} createPrefill={{ scope: "org", orgSlug: "vercel" }} />,
    );

    expect(html).toContain('id="add-webhook"');
    expect(html).toContain('id="webhook-org"');
    expect(html).toContain('value="vercel"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain(">Org<");

    // HTTPS endpoint is still required — Create stays disabled until a URL is entered.
    expect(html).toContain('id="webhook-url"');
    expect(html).toContain('type="url"');
    expect(html).toContain("Create webhook");
    expect(html).toMatch(/disabled[^>]*>Create webhook</);
  });

  it("keeps Follows selected when there is no deep-link prefill", () => {
    const html = renderToStaticMarkup(<WebhooksPanel initialWebhooks={[]} />);
    expect(html).toContain(">Follows<");
    expect(html).not.toContain('id="webhook-org"');
  });
});
