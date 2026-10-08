import { describe, it, expect } from "bun:test";
import { redactWebhookUrl } from "../../src/cli/commands/webhook-manage.js";

describe("redactWebhookUrl", () => {
  it("drops the Discord token (last path segment) and any query", () => {
    expect(
      redactWebhookUrl(
        "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz?wait=true",
      ),
    ).toBe("https://discord.com/api/webhooks/123456789012345678/••••");
  });

  it("drops the Slack secret (last path segment)", () => {
    expect(redactWebhookUrl("https://hooks.slack.com/services/T012AB/B034CD/Xy7zSecret")).toBe(
      "https://hooks.slack.com/services/T012AB/B034CD/••••",
    );
  });

  it("redacts a single-segment JSON endpoint the same way", () => {
    expect(redactWebhookUrl("https://your.app/hook")).toBe("https://your.app/••••");
  });

  it("keeps a host-only URL (nothing to token-strip)", () => {
    expect(redactWebhookUrl("https://hooks.example.com")).toBe("https://hooks.example.com");
  });

  it("does not echo an unparseable string", () => {
    expect(redactWebhookUrl("not a url")).toBe("••••");
  });
});
