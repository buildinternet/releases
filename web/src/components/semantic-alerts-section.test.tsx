import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SemanticAlert } from "@/lib/semantic-alerts";
import { SemanticAlertsSection } from "./semantic-alerts-section.tsx";

function alert(overrides: Partial<SemanticAlert> = {}): SemanticAlert {
  return {
    id: "sal_1",
    query: "Slack integrations with B2B software",
    enabled: true,
    threshold: 0.8,
    deliverEmail: true,
    deliverWebhook: false,
    webhookSubscriptionId: null,
    createdAt: "2026-09-22T00:00:00.000Z",
    updatedAt: "2026-09-22T00:00:00.000Z",
    ...overrides,
  };
}

describe("SemanticAlertsSection", () => {
  it("shows an empty state and a disabled save button until there is text", () => {
    const html = renderToStaticMarkup(<SemanticAlertsSection alerts={[]} webhooks={[]} />);
    expect(html).toContain("Interest alerts");
    expect(html).toContain("No interest alerts yet");
    expect(html).toContain("we send an email or a webhook");
    expect(html).not.toContain("not live yet");
    expect(html).toContain("0 of 5");
    expect(html).toMatch(/disabled[^>]*>Save alert</);
  });

  it("lists a saved alert with its threshold and an enable switch", () => {
    const html = renderToStaticMarkup(
      <SemanticAlertsSection alerts={[alert({ enabled: false })]} webhooks={[]} />,
    );
    expect(html).toContain("Slack integrations with B2B software");
    expect(html).toContain("Threshold 0.80");
    expect(html).toContain('aria-label="Enable interest alert"');
    expect(html).toContain("Delete");
    expect(html).not.toContain("No interest alerts yet");
  });

  it("disables create once the account is at the cap", () => {
    const alerts = Array.from({ length: 5 }, (_, i) =>
      alert({ id: `sal_${i}`, query: `interest ${i}` }),
    );
    const html = renderToStaticMarkup(<SemanticAlertsSection alerts={alerts} webhooks={[]} />);
    expect(html).toContain("5 of 5");
    expect(html).toContain("limit reached");
    expect(html).toMatch(/disabled[^>]*>Save alert</);
  });
});
