import { describe, expect, it } from "bun:test";
import { formatUserAutoPauseEmail, formatWorkspaceAutoPauseEmail } from "./user-notify.js";

describe("formatUserAutoPauseEmail", () => {
  it("includes endpoint, org, and account link", () => {
    const { subject, text } = formatUserAutoPauseEmail({
      recipientName: "Ada",
      url: "https://example.com/hook",
      description: "Prod hook",
      orgName: "Acme",
      orgSlug: "acme",
      consecutiveFailures: 10,
      lastError: "timeout",
      disabledReason: "auto-disabled after 10 consecutive delivery failures",
      accountUrl: "https://releases.sh/account",
    });
    expect(subject.length).toBeGreaterThan(0);
    expect(subject.toLowerCase()).toContain("paused");
    expect(text).toContain("Hi Ada");
    expect(text).toContain("https://example.com/hook");
    expect(text).toContain("Acme (acme)");
    expect(text).toContain("timeout");
    expect(text).toContain("https://releases.sh/account");
  });
});

describe("formatWorkspaceAutoPauseEmail", () => {
  it("names the workspace, endpoint, org, and workspace webhooks link", () => {
    const { subject, text } = formatWorkspaceAutoPauseEmail({
      recipientName: null,
      url: "https://example.com/hook",
      description: "Prod hook",
      workspaceName: "Acme Workspace",
      orgName: "Acme",
      orgSlug: "acme",
      consecutiveFailures: 10,
      lastError: "timeout",
      disabledReason: "auto-disabled after 10 consecutive delivery failures",
      workspaceWebhooksUrl: "https://releases.sh/account/workspace-webhooks",
    });
    expect(subject.length).toBeGreaterThan(0);
    expect(subject.toLowerCase()).toContain("paused");
    expect(subject).toContain("Acme Workspace");
    expect(text).toContain("Acme Workspace");
    expect(text).toContain("https://example.com/hook");
    expect(text).toContain("Acme (acme)");
    expect(text).toContain("timeout");
    expect(text).toContain("https://releases.sh/account/workspace-webhooks");
    expect(text).toContain("owner or admin of the Acme Workspace workspace");
  });
});
