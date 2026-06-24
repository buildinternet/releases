import { describe, expect, test } from "bun:test";
import { slackWebhookAppId } from "./slack-app-id.js";

describe("slackWebhookAppId", () => {
  test("extracts the T/B workspace+app pair", () => {
    expect(
      slackWebhookAppId("https://hooks.slack.com/services/T012AB/B034CD/Xy7zSecretToken"),
    ).toBe("T012AB/B034CD");
  });

  test("never includes the secret third segment", () => {
    const id = slackWebhookAppId("https://hooks.slack.com/services/T1/B2/SuperSecret999");
    expect(id).toBe("T1/B2");
    expect(id).not.toContain("SuperSecret999");
  });

  test("handles the GovSlack host", () => {
    expect(slackWebhookAppId("https://hooks.slack-gov.com/services/T1/B2/secret")).toBe("T1/B2");
  });

  test("returns empty for a non-Slack host", () => {
    expect(slackWebhookAppId("https://example.com/services/T1/B2/s")).toBe("");
  });

  test("returns empty for the workflow-trigger form", () => {
    expect(slackWebhookAppId("https://hooks.slack.com/triggers/T1/123/abc")).toBe("");
  });

  test("returns empty for an unparseable URL", () => {
    expect(slackWebhookAppId("not a url")).toBe("");
  });
});
