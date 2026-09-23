import { describe, expect, it } from "bun:test";
import { buildSemanticAlertEmail } from "../src/lib/email/semantic-alert-email.js";

const manageUrl = "https://releases.sh/account/notifications";
const releaseUrl = "https://releases.sh/release/rel_sample-slack-for-finance-teams";

function render(opts?: { releaseUrl?: string | null }) {
  return buildSemanticAlertEmail({
    recipientName: "Ada",
    query: "Slack integrations with B2B software",
    releaseTitle: "Slack for finance teams",
    sourceName: "Example Changelog",
    summary: null,
    releaseUrl: opts && "releaseUrl" in opts ? (opts.releaseUrl ?? null) : releaseUrl,
    manageUrl,
  });
}

describe("buildSemanticAlertEmail", () => {
  it("keeps View release as the only primary button", () => {
    const { html, text } = render();
    expect(html.match(/padding:12px 22px/g)?.length).toBe(1);
    expect(html).toContain(">View release</a>");
    expect(html).toContain("Or paste this link into your browser:");
    // Button href, the paste-line href, and the paste-line text.
    expect(html.split(releaseUrl).length - 1).toBe(3);
    expect(text).toContain(`View release: ${releaseUrl}`);
  });

  it("renders Manage alerts once, as a text link beside the fine print", () => {
    const { html, text } = render();
    expect(html).toContain(">Manage alerts</a>");
    expect(html).toContain("Turn this alert off or edit it from your notification settings.");
    expect(html).not.toContain(`Or paste this link into your browser:<br><a href="${manageUrl}"`);
    // The button cell is white-on-blue. Manage alerts must not use it.
    expect(html).not.toContain(`color:#ffffff;text-decoration:none;">Manage alerts</a>`);
    expect(html.split(manageUrl).length - 1).toBe(1);
    expect(text).toContain(`Manage alerts (${manageUrl}).`);
    expect(text.split(manageUrl).length - 1).toBe(1);
    expect(text).not.toContain("Manage alerts:");
  });

  it("still offers manage alerts when the release has no link", () => {
    const { html, text } = render({ releaseUrl: null });
    expect(html).not.toContain("padding:12px 22px");
    expect(html).not.toContain("View release");
    expect(html.split(manageUrl).length - 1).toBe(1);
    expect(text.split(manageUrl).length - 1).toBe(1);
  });

  it("names the interest in the body and the reason in the footer", () => {
    const { html, text, subject } = render();
    expect(subject).toContain("Slack for finance teams");
    expect(html).toContain("Slack integrations with B2B software");
    expect(html).toContain("matched an interest alert");
    expect(text).toContain("matched an interest alert");
    expect(html).not.toContain("semantic alert");
    expect(text).not.toContain("semantic alert");
  });
});
