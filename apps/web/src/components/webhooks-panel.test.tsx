import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { UserWebhookListItem } from "@buildinternet/releases-api-types";
import { WebhooksPanel } from "./webhooks-panel.tsx";

const WORKSPACE_SUB: UserWebhookListItem = {
  id: "whk_ws1",
  scope: "org",
  orgId: "org_1",
  orgSlug: "vercel",
  orgName: "Vercel",
  url: "https://ex.com/hook",
  sourceId: null,
  sourceSlug: null,
  sourceName: null,
  productId: null,
  productSlug: null,
  productName: null,
  releaseType: null,
  format: "json",
  enabled: true,
  description: null,
  secretVersion: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastSuccessAt: null,
  lastErrorAt: null,
  lastErrorMsg: null,
  consecutiveFailures: 0,
  disabledReason: null,
  failureStreakStartedAt: null,
  deliveryHealth: "never_delivered",
  deliveryHealthSummary: "No deliveries yet.",
};

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

describe("WebhooksPanel workspace mode (#2324)", () => {
  it("hides the Follows/Org scope toggle when allowFollows is false", () => {
    const html = renderToStaticMarkup(<WebhooksPanel initialWebhooks={[]} allowFollows={false} />);
    expect(html).not.toContain(">Follows<");
    expect(html).not.toContain('aria-label="Webhook scope"');
    // Org-only create form still renders.
    expect(html).toContain('id="webhook-org"');
  });

  it("hides create/manage controls and shows the read-only notice when canManage is false", () => {
    const html = renderToStaticMarkup(
      <WebhooksPanel initialWebhooks={[WORKSPACE_SUB]} allowFollows={false} canManage={false} />,
    );
    // No create form, no Pause/Resume, Rotate key, or Delete.
    expect(html).not.toContain('id="add-webhook"');
    expect(html).not.toContain(">Pause<");
    expect(html).not.toContain(">Resume<");
    expect(html).not.toContain("Rotate key");
    expect(html).not.toContain(">Delete<");
    expect(html).toContain("Only workspace owners and admins can add or change webhooks.");
    // Test + the delivery log stay available.
    expect(html).toContain("Send test");
    expect(html).toContain(">Activity<");
  });

  it("shows manage controls when canManage is true", () => {
    const html = renderToStaticMarkup(
      <WebhooksPanel initialWebhooks={[WORKSPACE_SUB]} allowFollows={false} canManage={true} />,
    );
    expect(html).toContain('id="add-webhook"');
    expect(html).toContain(">Pause<");
    expect(html).toContain(">Delete<");
    expect(html).not.toContain("Only workspace owners and admins can add or change webhooks.");
  });
});
