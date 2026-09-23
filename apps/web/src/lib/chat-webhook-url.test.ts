import { describe, expect, test } from "bun:test";
import { detectChatWebhookFormat } from "./chat-webhook-url";

describe("detectChatWebhookFormat", () => {
  test("recognizes Slack incoming webhooks", () => {
    expect(detectChatWebhookFormat("https://hooks.slack.com/services/T0/B0/xyz")).toBe("slack");
    expect(detectChatWebhookFormat("  https://hooks.slack-gov.com/services/T0/B0/x ")).toBe(
      "slack",
    );
  });

  test("recognizes Discord incoming webhooks", () => {
    expect(detectChatWebhookFormat("https://discord.com/api/webhooks/123/abc-DEF_1")).toBe(
      "discord",
    );
    expect(detectChatWebhookFormat("https://discordapp.com/api/v10/webhooks/123/tok")).toBe(
      "discord",
    );
  });

  test("rejects other URLs", () => {
    expect(detectChatWebhookFormat("http://hooks.slack.com/services/x")).toBeNull();
    expect(detectChatWebhookFormat("https://discord.com/channels/1/2")).toBeNull();
    expect(detectChatWebhookFormat("https://example.com/hook")).toBeNull();
    expect(detectChatWebhookFormat("not a url")).toBeNull();
  });
});
