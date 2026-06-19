import { describe, expect, it } from "bun:test";
import { formatUserAutoPauseEmail } from "./user-notify.js";

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
    expect(subject).toBe("Your Releases webhook was paused");
    expect(text).toContain("Hi Ada");
    expect(text).toContain("https://example.com/hook");
    expect(text).toContain("Acme (acme)");
    expect(text).toContain("timeout");
    expect(text).toContain("https://releases.sh/account");
  });
});
